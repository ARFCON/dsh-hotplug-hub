/**
 * dsh-hotplug-hub — 热插拔中枢（host 端）
 *
 * 设计原则（极简）：
 *  - 中枢本体不含任何原生插件 / 预设 / 技能，是一条空插座。
 *  - 只支持导入外部热插拔包（hotpack v1 manifest，见 docs/hotpack-format.zh.md）。
 *  - 路径调用：包内插件按「路径」挂载；profile node_modules 或 hotplug-store
 *    里已有同版本 → 直接调用（复用）；缺失才下载（缺失哪下哪）。
 *  - 无损替换：同一时刻只有一个激活包；切换包只替换 profile 的 patch 块 /
 *    bundles / link 依赖；全局记忆（~/.dsh/memory）、会话与 hotplug-store 不动。
 *
 * Remote 服务 `dshHotplug`（8 个方法；新增方法必须同步三处：
 * 本文件 methods 列表、lib/typert.js、lib/client.js 的 REMOTE.descriptors）：
 *   status()              中枢状态（profile / 激活包 / 已导入包 / store）
 *   importPack(text)      导入 hotpack JSON（字符串或对象），只落盘不挂载
 *   preview(packId)       预演激活计划：每个插件 reused / download / error
 *   activate(packId)      解析缺失插件并挂载（无损替换当前激活包）
 *   deactivate()          卸载当前激活包（保留 store 缓存）
 *   removePack(packId)    移除未激活的包记录
 *   check()               自检：Node/pnpm 版本、profile 状态、patch 状态、冲突矩阵
 *   marketList(params)    插件包市场：GitHub 标签搜索（官方 API + 镜像站兜底），
 *                         对比文件（package.json / hotpack / .dshpack / README）提取
 *                         介绍与安装方法，生成可导入的 hotpack manifest
 *
 * 红线（与 dsh-hub 同源）：
 *  - profile package.json / cordis.patch.yml 一律 writeTextSafe() 原子写；
 *  - 进 shell 的名字 / ref / repo 必须过白名单正则；参数走 argv；
 *  - 绝不执行包内任何脚本：npm 插件走 pnpm add（profile 正常依赖解析），
 *    github / path 源只做 link 挂载（同 graph-memory 模式）。
 *  - 市场联网抓取只读公开元数据（GitHub 搜索 JSON / raw README / package.json），
 *    不携带任何凭据；https 直连兜底仅对市场抓取关闭证书校验（兼容本地根 CA 拦截环境）。
 */
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { spawn } from 'node:child_process'
import https from 'node:https'
import {
  copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

const IS_WIN = process.platform === 'win32'
const CURL_BIN = IS_WIN ? 'curl.exe' : 'curl'
const TAR_BIN = IS_WIN ? 'tar.exe' : 'tar'
const ENSURE_TIMEOUT_MS = 5 * 60 * 1000
const DOWNLOAD_TIMEOUT_MS = 120 * 1000
const OUTPUT_CAP = 65536
const GITHUB_MIRRORS = ['https://ghfast.top/', 'https://gh-proxy.com/', 'https://ghproxy.net/']

// 插件包市场（详见下方「插件包市场」节）：GitHub topic 即「标签」
const MARKET_CACHE_FILE = () => join(hotplugRoot(), 'market-cache.json')
const MARKET_PAGE_SIZE = 10
const MARKET_DETAIL_CONCURRENCY = 4
const MARKET_TIMEOUT_MS = 15000
const MARKET_README_CANDIDATES = ['README.zh.md', 'README.md', 'readme.md', 'README_CN.md', 'README_ZH.md', 'Readme.md', 'README.txt']
const MARKET_PACK_CANDIDATES = ['hotpack.json', '.dshpack.json', 'dshpack.json']

const PACK_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i
const PLUGIN_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const REF_RE = /^[0-9A-Za-z._-]+$/
const REPO_RE = /^[0-9A-Za-z._-]+\/[0-9A-Za-z._-]+$/

// ---------- 路径 ----------

function homeDir() {
  const env = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return env !== '' ? env.replace(/[\\/]+$/, '') : join(homedir(), '.dsh')
}
function hotplugRoot() { return join(homeDir(), 'hotplug-hub') }
function packsDir() { return join(hotplugRoot(), 'packs') }
function storeRoot() { return join(homeDir(), 'hotplug-store') }
function statePath() { return join(hotplugRoot(), 'state.json') }

/** 选择 profile：DSH_PROFILE 环境变量优先，否则按 desktop → web → headless 取第一个存在的。 */
function profileName() {
  const env = typeof process.env.DSH_PROFILE === 'string' ? process.env.DSH_PROFILE.trim() : ''
  const candidates = env !== '' ? [env, 'desktop', 'web', 'headless'] : ['desktop', 'web', 'headless']
  for (const name of candidates) {
    if (existsSync(join(homeDir(), 'profiles', name, 'package.json'))) return name
  }
  return env !== '' ? env : 'web'
}
function profileDir() { return join(homeDir(), 'profiles', profileName()) }
function manifestPath() { return join(profileDir(), 'package.json') }
function patchPath() { return join(profileDir(), 'cordis.patch.yml') }

/** 把 ~ 与 $DSH_HOME 展开为绝对路径。 */
function expandPath(p) {
  if (typeof p !== 'string' || p.trim() === '') return null
  let out = p.trim()
  if (out.startsWith('~')) out = join(homedir(), out.slice(1).replace(/^[\\/]+/, ''))
  if (out.startsWith('$DSH_HOME')) out = join(homeDir(), out.slice('$DSH_HOME'.length).replace(/^[\\/]+/, ''))
  if (!isAbsolute(out)) out = join(homeDir(), out)
  return out
}

// ---------- 文件工具（原子写） ----------

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}
function writeTextSafe(path, text) {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, text, 'utf8')
  try { copyFileSync(path, `${path}.bak`) } catch {}
  try { rmSync(path, { force: true }) } catch {}
  renameSync(tmp, path)
}
function writeJsonSafe(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeTextSafe(path, JSON.stringify(value, null, 2) + '\n')
}

// ---------- 状态 ----------

function readState() {
  const state = readJson(statePath())
  return state && typeof state === 'object' ? state : { version: 1, activePack: null, history: [] }
}
function writeState(state) {
  writeJsonSafe(statePath(), { ...state, updatedAt: new Date().toISOString() })
}

function readPackManifest(packId) {
  if (typeof packId !== 'string' || !PACK_ID_RE.test(packId)) return null
  return readJson(join(packsDir(), packId, 'hotpack.json'))
}
function listPackIds() {
  try {
    return readdirSync(packsDir(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((id) => PACK_ID_RE.test(id))
      .sort()
  } catch {
    return []
  }
}

// ---------- 命令执行 ----------

function runCli(command, args, timeoutMs, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? profileDir(),
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: options.shell ?? IS_WIN,
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    child.stdout.on('data', (chunk) => {
      if (stdout.length < OUTPUT_CAP) stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < OUTPUT_CAP) stderr += String(chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: null, signal: 'error', stdout, stderr: `${stderr}\n${String(error.message ?? error)}` })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr })
    })
  })
}
function tail(text, lines = 8) {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '') return ''
  return trimmed.split('\n').slice(-lines).join('\n')
}

// ---------- hotpack 校验 ----------

function parseHotpack(input) {
  let raw = input
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw) } catch (error) {
      return { ok: false, error: `hotpack 不是合法 JSON：${String(error.message ?? error)}` }
    }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'hotpack 必须是 JSON 对象' }
  }
  if (raw.hotpack !== '1.0') return { ok: false, error: '只支持 hotpack 1.0（字段 "hotpack": "1.0"）' }
  const errors = []
  const id = raw.id
  const name = raw.name
  const version = raw.version
  if (typeof id !== 'string' || !PACK_ID_RE.test(id)) errors.push('id 必须是 1-64 位包名风格字符（字母开头，允许 . _ -）')
  if (typeof name !== 'string' || name.trim() === '' || name.length > 80) errors.push('name 缺失或过长')
  if (typeof version !== 'string' || !EXACT_VERSION_RE.test(version)) errors.push('version 必须是精确版本号')
  const pluginsRaw = raw.plugins
  if (!Array.isArray(pluginsRaw) || pluginsRaw.length === 0 || pluginsRaw.length > 64) {
    errors.push('plugins 必须是非空数组（最多 64 个）')
  }
  const plugins = []
  const seenIds = new Set()
  const seenNames = new Set()
  if (Array.isArray(pluginsRaw)) {
    for (const [index, item] of pluginsRaw.entries()) {
      const at = `plugins[${index}]`
      if (item === null || typeof item !== 'object' || Array.isArray(item)) { errors.push(`${at} 必须是对象`); continue }
      const pid = item.id
      const pname = item.name
      if (typeof pid !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(pid)) { errors.push(`${at}.id 非法`); continue }
      if (seenIds.has(pid)) { errors.push(`${at}.id 重复：${pid}`); continue }
      seenIds.add(pid)
      if (typeof pname !== 'string' || !PLUGIN_NAME_RE.test(pname) || pname.length > 214) { errors.push(`${at}.name 不是合法 npm 包名`); continue }
      if (seenNames.has(pname)) { errors.push(`${at}.name 重复：${pname}`); continue }
      seenNames.add(pname)
      const source = item.source === null || typeof item.source !== 'object' || Array.isArray(item.source) ? {} : item.source
      const type = source.type
      const entry = { id: pid, name: pname, source: { type }, config: item.config && typeof item.config === 'object' && !Array.isArray(item.config) ? item.config : {} }
      if (type === 'npm' || type === undefined) {
        entry.source.type = 'npm'
        if (typeof item.version !== 'string' || !EXACT_VERSION_RE.test(item.version)) { errors.push(`${at} npm 源必须给精确 version`); continue }
        entry.version = item.version
      } else if (type === 'path') {
        const abs = expandPath(source.path)
        if (abs === null) { errors.push(`${at} path 源必须给 source.path`); continue }
        entry.source.path = abs
      } else if (type === 'github') {
        const repo = source.repo
        const ref = source.ref ?? 'main'
        if (typeof repo !== 'string' || !REPO_RE.test(repo)) { errors.push(`${at} github 源必须给合法 source.repo（owner/repo）`); continue }
        if (typeof ref !== 'string' || !REF_RE.test(ref) || ref.length > 100) { errors.push(`${at} github 源 ref 只允许字母数字 . _ -`); continue }
        entry.source.repo = repo
        entry.source.ref = ref
      } else {
        errors.push(`${at} source.type 只支持 npm / path / github`)
        continue
      }
      plugins.push(entry)
    }
  }
  if (errors.length > 0) return { ok: false, error: errors.join('；') }
  const description = typeof raw.description === 'string' ? raw.description.slice(0, 300) : ''
  const tags = Array.isArray(raw.tags) ? raw.tags.filter((tag) => typeof tag === 'string').slice(0, 12).map((tag) => tag.slice(0, 24)) : []
  return {
    ok: true,
    pack: {
      hotpack: '1.0',
      id,
      name: String(name).trim(),
      version,
      description,
      tags,
      plugins,
      memory: { keep: true },
    },
  }
}

// ---------- 插件解析：有就直接调用，缺了才下 ----------

function npmModuleDir(pkgName) {
  return join(profileDir(), 'node_modules', ...pkgName.split('/'))
}
function storeDirOf(entry) {
  if (entry.source.type === 'github') return join(storeRoot(), `${entry.name}@${entry.source.ref}`)
  if (entry.source.type === 'path') return entry.source.path
  return npmModuleDir(entry.name)
}
function installedVersion(pkgName) {
  const meta = readJson(join(npmModuleDir(pkgName), 'package.json'))
  return meta && typeof meta.version === 'string' ? meta.version : null
}
function innerPackageName(dir) {
  const meta = readJson(join(dir, 'package.json'))
  return meta && typeof meta.name === 'string' ? meta.name : null
}

async function ensureNpm(entry) {
  const current = installedVersion(entry.name)
  if (current === entry.version) {
    return { ok: true, status: 'reused', path: npmModuleDir(entry.name), detail: `profile 已有 ${entry.name}@${entry.version}，直接调用` }
  }
  const spec = `${entry.name}@${entry.version}`
  const result = await runCli('pnpm', ['add', '--save-exact', spec], ENSURE_TIMEOUT_MS)
  const after = installedVersion(entry.name)
  if (result.code === 0 && after === entry.version) {
    return { ok: true, status: current === null ? 'downloaded' : 'replaced', path: npmModuleDir(entry.name), detail: `pnpm add ${spec} 完成` }
  }
  return { ok: false, status: 'error', error: `pnpm add ${spec} 失败（exit ${result.code}）：${tail(result.stderr || result.stdout)}` }
}

async function ensurePath(entry) {
  const dir = entry.source.path
  if (!existsSync(join(dir, 'package.json'))) {
    return { ok: false, status: 'error', error: `path 源不存在或缺少 package.json：${dir}` }
  }
  const inner = innerPackageName(dir)
  if (inner !== entry.name) {
    return { ok: false, status: 'error', error: `path 源内部包名 ${inner ?? '未知'} 与清单声明 ${entry.name} 不一致` }
  }
  return { ok: true, status: 'reused', path: dir, detail: '本地路径，直接调用' }
}

function githubZipUrls(repo, ref) {
  const base = `https://codeload.github.com/${repo}/zip/refs`
  const direct = [`${base}/heads/${ref}`, `${base}/tags/${ref}`]
  const mirrored = []
  for (const mirror of GITHUB_MIRRORS) {
    mirrored.push(`${mirror}${base}/heads/${ref}`, `${mirror}${base}/tags/${ref}`)
  }
  return [...direct, ...mirrored]
}

async function downloadZip(url, zipPath) {
  const args = ['-fSL', '--retry', '1', '--max-time', '110', '-o', zipPath, url]
  if (IS_WIN) args.splice(1, 0, '--ssl-no-revoke')
  const result = await runCli(CURL_BIN, args, DOWNLOAD_TIMEOUT_MS, { shell: false, cwd: tmpdir() })
  return result.code === 0 && existsSync(zipPath)
}

async function ensureGithub(entry) {
  const dest = storeDirOf(entry)
  if (existsSync(join(dest, 'package.json'))) {
    const inner = innerPackageName(dest)
    if (inner === entry.name) {
      return { ok: true, status: 'reused', path: dest, detail: `hotplug-store 已有 ${entry.name}@${entry.source.ref}，直接调用` }
    }
  }
  const zipPath = join(tmpdir(), `hotplug-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`)
  const extractDir = mkdtempSync(join(tmpdir(), 'hotplug-x-'))
  try {
    let downloaded = false
    for (const url of githubZipUrls(entry.source.repo, entry.source.ref)) {
      try { rmSync(zipPath, { force: true }) } catch {}
      if (await downloadZip(url, zipPath)) { downloaded = true; break }
    }
    if (!downloaded) return { ok: false, status: 'error', error: `GitHub 下载失败：${entry.source.repo}@${entry.source.ref}（已尝试官方源与国内镜像）` }
    let extract = await runCli(TAR_BIN, ['-xf', zipPath, '-C', extractDir], DOWNLOAD_TIMEOUT_MS, { shell: false })
    if (extract.code !== 0 && process.platform === 'linux') {
      extract = await runCli('unzip', ['-q', zipPath, '-d', extractDir], DOWNLOAD_TIMEOUT_MS, { shell: false })
    }
    if (extract.code !== 0) return { ok: false, status: 'error', error: `解压失败：${tail(extract.stderr)}` }
    const roots = readdirSync(extractDir)
    const root = roots.length === 1 ? join(extractDir, roots[0]) : extractDir
    if (!existsSync(join(root, 'package.json'))) return { ok: false, status: 'error', error: 'GitHub 包根目录缺少 package.json' }
    const inner = innerPackageName(root)
    if (inner !== entry.name) {
      return { ok: false, status: 'error', error: `GitHub 包内部包名 ${inner ?? '未知'} 与清单声明 ${entry.name} 不一致` }
    }
    rmSync(dest, { recursive: true, force: true })
    mkdirSync(dirname(dest), { recursive: true })
    cpSync(root, dest, { recursive: true })
    return { ok: true, status: 'downloaded', path: dest, detail: `已下载 ${entry.source.repo}@${entry.source.ref} 到 hotplug-store` }
  } finally {
    try { rmSync(zipPath, { force: true }) } catch {}
    try { rmSync(extractDir, { recursive: true, force: true }) } catch {}
  }
}

async function ensureEntry(entry) {
  if (entry.source.type === 'npm') return ensureNpm(entry)
  if (entry.source.type === 'path') return ensurePath(entry)
  return ensureGithub(entry)
}

// ---------- profile 挂载 ----------

function patchInstanceId(packId, pluginId) {
  return `hp-${packId}-${pluginId}`.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 64)
}
function patchMarker(packId) { return `# hotplug:${packId}` }

function buildPatchBlock(pack) {
  const lines = [`- insert:  ${patchMarker(pack.id)}`]
  for (const entry of pack.plugins) {
    lines.push(`    - id: ${patchInstanceId(pack.id, entry.id)}`)
    lines.push(`      name: '${entry.name}'`)
    lines.push(`      config: ${JSON.stringify(entry.config ?? {})}`)
  }
  return lines.join('\n') + '\n'
}

function appendPatchBlock(pack) {
  const path = patchPath()
  let text = existsSync(path) ? readFileSync(path, 'utf8') : ''
  if (text.includes(patchMarker(pack.id))) return { ok: false, error: 'patch 中已存在同名 hotplug 块（状态可能不一致，请先 deactivate）' }
  if (text !== '' && !text.endsWith('\n')) text += '\n'
  writeTextSafe(path, text + buildPatchBlock(pack))
  return { ok: true }
}

function removePatchBlock(packId) {
  const path = patchPath()
  if (!existsSync(path)) return false
  const lines = readFileSync(path, 'utf8').split('\n')
  const markerRe = new RegExp(`#\\s*hotplug:${packId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`)
  const start = lines.findIndex((line) => markerRe.test(line))
  if (start === -1) return false
  let end = start + 1
  while (end < lines.length && (lines[end].startsWith(' ') || lines[end].startsWith('\t') || lines[end].trim() === '')) end++
  lines.splice(start, end - start)
  writeTextSafe(path, lines.join('\n'))
  return true
}

function bundlePkgNames(pack) {
  const names = []
  for (const entry of pack.plugins) {
    const meta = readJson(join(storeDirOf(entry), 'package.json'))
    if (meta?.dsh?.bundle?.patch !== undefined) names.push(entry.name)
  }
  return names
}

function linkEntryIntoProfile(entry) {
  const target = storeDirOf(entry)
  const manifest = readJson(manifestPath())
  if (manifest === null) return { ok: false, error: 'profile package.json 不可读' }
  manifest.dependencies = manifest.dependencies ?? {}
  manifest.dependencies[entry.name] = `link:${target.replace(/\\/g, '/')}`
  writeJsonSafe(manifestPath(), manifest)
  const linkPath = npmModuleDir(entry.name)
  if (!existsSync(linkPath)) {
    mkdirSync(dirname(linkPath), { recursive: true })
    symlinkSync(target, linkPath, 'junction')
  }
  return { ok: true }
}

function unlinkEntryFromProfile(entry, manifest) {
  let changed = false
  if (manifest.dependencies?.[entry.name] !== undefined && String(manifest.dependencies[entry.name]).startsWith('link:')) {
    delete manifest.dependencies[entry.name]
    changed = true
  }
  const linkPath = npmModuleDir(entry.name)
  try {
    if (lstatSync(linkPath).isSymbolicLink()) {
      rmSync(linkPath, { force: true })
      changed = true
    }
  } catch {}
  return changed
}

function addBundles(names) {
  if (names.length === 0) return
  const manifest = readJson(manifestPath())
  if (manifest === null) return
  manifest.dsh = manifest.dsh ?? {}
  manifest.dsh.profile = manifest.dsh.profile ?? {}
  const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
  let changed = false
  for (const name of names) {
    if (!bundles.includes(name)) { bundles.push(name); changed = true }
  }
  if (changed) {
    manifest.dsh.profile.bundles = bundles
    writeJsonSafe(manifestPath(), manifest)
  }
}

function removeBundles(names) {
  if (names.length === 0) return
  const manifest = readJson(manifestPath())
  if (manifest === null) return
  const bundles = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
  const next = bundles.filter((name) => !names.includes(name))
  if (next.length !== bundles.length) {
    manifest.dsh.profile.bundles = next
    writeJsonSafe(manifestPath(), manifest)
  }
}

// ---------- 激活 / 卸载 ----------

async function unmountPack(pack) {
  removePatchBlock(pack.id)
  const bundleNames = bundlePkgNames(pack)
  removeBundles(bundleNames)
  const manifest = readJson(manifestPath())
  const linkEntries = pack.plugins.filter((entry) => entry.source.type !== 'npm')
  if (manifest !== null) {
    let changed = false
    for (const entry of linkEntries) changed = unlinkEntryFromProfile(entry, manifest) || changed
    if (changed) writeJsonSafe(manifestPath(), manifest)
  }
  const npmNames = pack.plugins
    .filter((entry) => entry.source.type === 'npm')
    .map((entry) => entry.name)
    .filter((name) => manifest?.dependencies?.[name] !== undefined)
  if (npmNames.length > 0) {
    const result = await runCli('pnpm', ['remove', ...npmNames], ENSURE_TIMEOUT_MS)
    if (result.code !== 0) {
      return { ok: false, error: `pnpm remove 失败（profile 可能残留依赖，可手动处理）：${tail(result.stderr || result.stdout)}` }
    }
  }
  return { ok: true }
}

async function mountPack(pack) {
  const steps = []
  for (const entry of pack.plugins) {
    const ensured = await ensureEntry(entry)
    if (!ensured.ok) return { ok: false, error: ensured.error, steps }
    steps.push({ id: entry.id, name: entry.name, status: ensured.status, detail: ensured.detail })
  }
  const manifest = readJson(manifestPath())
  if (manifest === null) return { ok: false, error: 'profile package.json 不可读', steps }
  for (const entry of pack.plugins.filter((item) => item.source.type !== 'npm')) {
    const linked = linkEntryIntoProfile(entry)
    if (!linked.ok) return { ok: false, error: linked.error, steps }
  }
  addBundles(bundlePkgNames(pack))
  const patched = appendPatchBlock(pack)
  if (!patched.ok) return { ok: false, error: patched.error, steps }
  return { ok: true, steps, restartNeeded: true }
}

// ---------- 插件包市场（真实数据源） ----------

function sanitizeTopic(topic) {
  if (typeof topic !== 'string') return null
  const tokens = topic.split(/[,，\s]+/).map((s) => s.trim()).filter((s) => s !== '')
  if (tokens.length === 0 || tokens.length > 4) return null
  for (const token of tokens) {
    if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$/.test(token)) return null
  }
  return tokens.join(' ')
}

function sanitizeMarketParams(params) {
  const p = params && typeof params === 'object' ? params : {}
  const topic = sanitizeTopic(p.topic ?? 'dsh-plugin')
  if (topic === null) return { ok: false, error: 'topic 只能是标签字符串（字母数字 . _ -，最长 32 字符，最多 4 个，逗号/空格分隔）' }
  const q = typeof p.q === 'string' ? p.q.trim().slice(0, 80) : ''
  const source = p.source === 'github' || p.source === 'mirror' ? p.source : 'auto'
  const page = Math.min(Math.max(parseInt(String(p.page), 10) || 1, 1), 10)
  return { ok: true, topic, q, source, page, refresh: p.refresh === true }
}

/**
 * GET 文本，三层兜底，只用于市场公开只读抓取：
 *  1) 运行时全局 fetch（DSH 应用进程通常已配置系统 CA / 代理，可直接用）
 *  2) node:https 直连 rejectUnauthorized:false（兼容本地根 CA 拦截环境，如企业 MITM；
 *     仅限公开只读元数据，不携带凭据、不触发写操作）
 *  3) curl 兜底（schannel 正常的环境）
 */
function httpsGetText(url, timeoutMs, headers, hops = 0) {
  return new Promise((resolve) => {
    let settled = false
    const done = (value) => { if (!settled) { settled = true; resolve(value) } }
    const req = https.get(url, { rejectUnauthorized: false, headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 3) {
        res.resume()
        let next = res.headers.location
        if (next.startsWith('/')) {
          const base = new URL(url)
          next = base.origin + next
        }
        done(httpsGetText(next, timeoutMs, headers, hops + 1))
        return
      }
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { if (data.length < 1000000) data += chunk })
      res.on('end', () => done(res.statusCode === 200 ? { ok: true, status: 200, text: data } : { ok: false, status: res.statusCode, text: '' }))
    })
    req.setTimeout(timeoutMs, () => { try { req.destroy() } catch {} })
    req.on('error', () => done({ ok: false, status: 0, text: '' }))
  })
}

async function httpGet(url, timeoutMs = MARKET_TIMEOUT_MS, extraHeaders = {}) {
  const headers = { 'User-Agent': 'dsh-hotplug-hub/' + VERSION, ...extraHeaders }
  if (typeof fetch === 'function') {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    try {
      const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers })
      if (res.ok) return { ok: true, status: res.status, text: await res.text() }
      return { ok: false, status: res.status, text: '' }
    } catch {
      // 网络 / TLS 失败 → 继续尝试 https 直连与 curl
    } finally {
      clearTimeout(timer)
    }
  }
  const viaHttps = await httpsGetText(url, timeoutMs, headers)
  if (viaHttps.ok) return viaHttps
  const args = ['-fsSL', '--max-time', String(Math.ceil(timeoutMs / 1000)), '--retry', '1']
  if (IS_WIN) args.splice(1, 0, '--ssl-no-revoke')
  args.push(url)
  const result = await runCli(CURL_BIN, args, timeoutMs + 5000, { shell: false, cwd: tmpdir() })
  if (result.code === 0 && result.stdout !== '') return { ok: true, status: 200, text: result.stdout }
  return { ok: false, status: 0, text: '' }
}

/** 按候选 URL 依次抓取；官方返回 404 视为文件不存在，不再试镜像。 */
async function scanFiles(urls, timeoutMs, extraHeaders) {
  for (const url of urls) {
    const res = await httpGet(url, timeoutMs, extraHeaders)
    if (res.ok) return { ok: true, text: res.text, url }
    if (res.status === 404) return { ok: false, status: 404, text: '' }
  }
  return { ok: false, text: '' }
}

function apiSearchUrls(topic, q, page, source) {
  const topicQuery = topic.split(' ').map((t) => 'topic:' + t).join(' ')
  const query = 'q=' + encodeURIComponent(topicQuery) + (q !== '' ? '+' + encodeURIComponent(q) : '') +
    '&sort=stars&order=desc&per_page=' + MARKET_PAGE_SIZE + '&page=' + page
  const base = 'https://api.github.com/search/repositories?' + query
  if (source === 'github') return [base]
  if (source === 'mirror') return GITHUB_MIRRORS.map((m) => m + base)
  return [base, ...GITHUB_MIRRORS.map((m) => m + base)]
}

function rawFileUrls(repo, ref, path, source) {
  const base = 'https://raw.githubusercontent.com/' + repo + '/' + ref + '/' + path
  if (source === 'github') return [base]
  if (source === 'mirror') return GITHUB_MIRRORS.map((m) => m + base)
  return [base, ...GITHUB_MIRRORS.map((m) => m + base)]
}

async function searchMarketRepos(topic, q, page, source) {
  let lastError = ''
  for (const url of apiSearchUrls(topic, q, page, source)) {
    const res = await httpGet(url, 20000, { Accept: 'application/vnd.github+json' })
    if (!res.ok) { lastError = 'HTTP ' + res.status; continue }
    try {
      const json = JSON.parse(res.text)
      if (!Array.isArray(json.items)) { lastError = json.message ?? '响应结构异常'; continue }
      const items = json.items
        .filter((item) => item.fork !== true)
        .slice(0, MARKET_PAGE_SIZE)
        .map((item) => ({
          repo: item.full_name,
          ref: item.default_branch ?? 'main',
          name: item.name,
          author: (item.owner && item.owner.login) || String(item.full_name || '').split('/')[0],
          stars: item.stargazers_count ?? 0,
          forks: item.forks_count ?? 0,
          license: (item.license && item.license.spdx_id) || '',
          description: item.description ?? '',
          topics: Array.isArray(item.topics) ? item.topics.slice(0, 12) : [],
          updatedAt: item.updated_at ?? '',
        }))
      return { ok: true, total: json.total_count ?? items.length, items, url }
    } catch (error) {
      lastError = String(error.message ?? error)
    }
  }
  return { ok: false, error: lastError || '网络请求失败' }
}

/** 语言切换 / 导航类短段（如 "[English](README.md) 中文"），不作为介绍。 */
function looksLikeNav(para) {
  const t = para.replace(/<[^>]+>/g, ' ').replace(/\[[^\]]*\]\([^)]*\)/g, ' ').replace(/[|·\-—=>]/g, ' ').replace(/\s+/g, ' ').trim()
  if (t === '' || t.length >= 30) return false
  return /English|中文|한국어|日本語|简体|繁體|Deutsch|Français|Español/i.test(t)
}

function extractIntro(readmeText) {
  const text = String(readmeText ?? '').replace(/^\uFEFF/, '')
  const body = text.replace(/^#{1,6}\s+.*$/m, '').trim()
  const paras = body.split(/\n\s*\n/).map((s) => s.trim()).filter((s) => s !== '')
  const clean = (p) => p
    .replace(/<[^>]+>/g, ' ')
    .replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/[#*_`>[\]|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  for (const p of paras) {
    const t = clean(p)
    if (t === '' || looksLikeNav(p)) continue
    return t.length > 280 ? t.slice(0, 280) + '…' : t
  }
  for (const p of paras) {
    const t = clean(p)
    if (t !== '') return t.length > 280 ? t.slice(0, 280) + '…' : t
  }
  return ''
}

function extractInstall(readmeText) {
  const text = String(readmeText ?? '')
  const lines = text.split('\n')
  const headingRe = /^#{2,4}\s*(安装|安装方法|安装与使用|Installation|Quick Start|快速开始|使用|Usage|Getting Started)/i
  const start = lines.findIndex((line) => headingRe.test(line))
  if (start === -1) return ''
  const out = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^#{1,6}\s+/.test(line)) break
    out.push(line)
  }
  const block = out.join('\n').replace(/```/g, '').replace(/<[^>]+>/g, ' ').replace(/[ \t]+\n/g, '\n').trim()
  return block.length > 1200 ? block.slice(0, 1200) + '\n…' : block
}

/** .dshpack.json（规划格式）→ hotpack v1 转换；bundles 必须是精确 npm 版本。 */
function dshpackToHotpack(text) {
  let raw
  try { raw = JSON.parse(text) } catch { return { ok: false, error: '.dshpack.json 不是合法 JSON' } }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: '.dshpack.json 必须是对象' }
  const bundles = Array.isArray(raw.bundles) ? raw.bundles : []
  const plugins = []
  bundles.forEach((bundle, index) => {
    if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) return
    const name = bundle.package ?? bundle.name
    const version = bundle.version
    if (typeof name !== 'string' || typeof version !== 'string') return
    const role = typeof bundle.role === 'string' && bundle.role !== '' ? bundle.role : 'plugin' + (index + 1)
    const id = role.toLowerCase().replace(/[^a-z0-9_]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'plugin' + (index + 1)
    plugins.push({ id, name, version, source: { type: bundle.source === 'github' ? 'github' : 'npm' } })
  })
  return parseHotpack(JSON.stringify({
    hotpack: '1.0',
    id: raw.packId ?? raw.id,
    name: raw.name,
    version: raw.version,
    description: raw.description ?? '',
    tags: raw.tags ?? [],
    plugins,
  }))
}

function packIdOf(repo) { return ('pack.' + repo).toLowerCase().replace(/[^a-z0-9._-]/g, '-').slice(0, 64) }

/** 单插件 github 源 manifest：有 package.json 但仓库本身不是包集合时兜底生成。 */
function buildGithubPluginPack(repo, ref, npmName, version, meta) {
  const tags = [...new Set([...(meta.topics ?? []), ...(meta.keywords ?? [])])].slice(0, 12).map((t) => String(t).slice(0, 24))
  return parseHotpack(JSON.stringify({
    hotpack: '1.0',
    id: packIdOf(repo),
    name: meta.name ?? repo,
    version: EXACT_VERSION_RE.test(String(version ?? '')) ? version : '0.0.0',
    description: (meta.description ?? '').slice(0, 300),
    tags,
    plugins: [{ id: 'main', name: npmName, source: { type: 'github', repo, ref } }],
  }))
}

async function fetchRepoDetail(repo, ref, meta, source) {
  const entry = {
    id: packIdOf(repo),
    repo,
    ref,
    repoUrl: 'https://github.com/' + repo,
    name: meta.name || String(repo).split('/')[1],
    author: meta.author,
    stars: meta.stars,
    forks: meta.forks,
    license: meta.license,
    description: meta.description,
    topics: meta.topics,
    updatedAt: meta.updatedAt,
    npmName: null,
    version: null,
    hasPack: false,
    packKind: null,
    intro: '',
    install: '',
    readmeUrl: null,
    importable: true,
    importError: null,
    manifest: null,
  }
  const raw = (name) => rawFileUrls(repo, ref, name, source)
  // 三路并发：包清单（hotpack/.dshpack）· package.json · README（候选对比）
  const [packScan, pkgRes, readmeScan] = await Promise.all([
    (async () => {
      for (const name of MARKET_PACK_CANDIDATES) {
        const res = await scanFiles(raw(name), MARKET_TIMEOUT_MS)
        if (!res.ok) continue
        const parsed = name === 'hotpack.json' ? parseHotpack(res.text) : dshpackToHotpack(res.text)
        if (parsed.ok) return { name, pack: parsed.pack }
      }
      return null
    })(),
    scanFiles(raw('package.json'), MARKET_TIMEOUT_MS),
    (async () => {
      for (const name of MARKET_README_CANDIDATES) {
        const res = await scanFiles(raw(name), MARKET_TIMEOUT_MS)
        if (res.ok) return { name, text: res.text }
      }
      return null
    })(),
  ])
  // 1) 包 manifest：repo 本身就是包集合 → 直接作为导入对象
  if (packScan) {
    entry.hasPack = true
    entry.packKind = packScan.name
    entry.manifest = packScan.pack
    entry.version = packScan.pack.version
    if (!entry.npmName && packScan.pack.plugins[0]) entry.npmName = packScan.pack.plugins[0].name
  }
  // 2) package.json：取 npm 包名与版本（对比文件之一）
  if (pkgRes && pkgRes.ok) {
    try {
      const pkg = JSON.parse(pkgRes.text)
      if (typeof pkg.name === 'string') entry.npmName = entry.npmName ?? pkg.name
      if (typeof pkg.version === 'string') entry.version = entry.version ?? pkg.version
    } catch {}
  }
  // 3) README：提取介绍（首段）与安装方法（## 安装 / Installation / 快速开始 等小节）
  if (readmeScan) {
    entry.readmeUrl = 'https://github.com/' + repo + '/blob/' + ref + '/' + readmeScan.name
    entry.intro = extractIntro(readmeScan.text)
    entry.install = extractInstall(readmeScan.text)
  }
  // 4) 兜底生成单插件 manifest（github 源由中枢下载 + link，不跑脚本）
  if (!entry.manifest) {
    if (entry.npmName) {
      const built = buildGithubPluginPack(repo, ref, entry.npmName, entry.version, {
        name: entry.name, description: entry.description, topics: entry.topics,
      })
      if (built.ok) entry.manifest = built.pack
      else { entry.importable = false; entry.importError = built.error }
    } else {
      entry.importable = false
      entry.importError = '未找到 package.json 或 hotpack/.dshpack 清单，无法生成导入包'
    }
  }
  return entry
}

async function marketListAsync(params) {
  const valid = sanitizeMarketParams(params)
  if (!valid.ok) return { ok: false, error: valid.error }
  const cacheKey = valid.topic + '|' + valid.q + '|' + valid.source + '|' + valid.page
  if (!valid.refresh) {
    const cache = readJson(MARKET_CACHE_FILE())
    if (cache && cache.key === cacheKey && Array.isArray(cache.entries)) {
      return { ok: true, cached: true, cachedAt: cache.cachedAt, total: cache.total, page: cache.page, source: cache.source, entries: cache.entries }
    }
  }
  const search = await searchMarketRepos(valid.topic, valid.q, valid.page, valid.source)
  if (!search.ok) return { ok: false, error: search.error }
  const entries = []
  let index = 0
  const worker = async () => {
    while (index < search.items.length) {
      const item = search.items[index++]
      try {
        entries.push(await fetchRepoDetail(item.repo, item.ref, item, valid.source))
      } catch (error) {
        entries.push({
          id: packIdOf(item.repo), repo: item.repo, ref: item.ref,
          repoUrl: 'https://github.com/' + item.repo,
          name: item.name, author: item.author, stars: item.stars, forks: item.forks,
          license: item.license, description: item.description, topics: item.topics,
          updatedAt: item.updatedAt, npmName: null, version: null,
          hasPack: false, packKind: null, intro: '', install: '', readmeUrl: null,
          importable: false, importError: String(error.message ?? error), manifest: null,
        })
      }
    }
  }
  await Promise.all(Array.from({ length: MARKET_DETAIL_CONCURRENCY }, () => worker()))
  entries.sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0))
  const result = { ok: true, cached: false, cachedAt: null, total: search.total, page: valid.page, source: valid.source, entries }
  try {
    writeJsonSafe(MARKET_CACHE_FILE(), { key: cacheKey, ...result, cachedAt: new Date().toISOString() })
  } catch {}
  return result
}

// ---------- 对外方法实现 ----------

function statusSync() {
  const state = readState()
  const packs = []
  for (const id of listPackIds()) {
    const manifest = readPackManifest(id)
    if (manifest === null) continue
    packs.push({
      id,
      name: manifest.name ?? id,
      version: manifest.version ?? null,
      description: manifest.description ?? '',
      tags: manifest.tags ?? [],
      active: state.activePack === id,
      activatedAt: state.history?.find?.((item) => item.packId === id && item.event === 'activate')?.at ?? null,
      plugins: (manifest.plugins ?? []).map((entry) => {
        const dir = storeDirOf(entry)
        const present = existsSync(join(dir, 'package.json'))
        const current = entry.source.type === 'npm' ? installedVersion(entry.name) : null
        return {
          id: entry.id,
          name: entry.name,
          version: entry.version ?? null,
          source: entry.source.type,
          path: dir,
          cached: entry.source.type === 'npm' ? current === entry.version : present,
        }
      }),
    })
  }
  let storeEntries = []
  try {
    storeEntries = readdirSync(storeRoot(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {}
  const patchText = existsSync(patchPath()) ? readFileSync(patchPath(), 'utf8') : ''
  return {
    version: VERSION,
    home: homeDir(),
    profile: { name: profileName(), dir: profileDir() },
    activePack: state.activePack ?? null,
    activePatchOk: state.activePack ? patchText.includes(patchMarker(state.activePack)) : true,
    packs,
    store: { dir: storeRoot(), entries: storeEntries },
  }
}

function importPackSync(input) {
  const parsed = parseHotpack(input)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  const pack = parsed.pack
  const state = readState()
  if (state.activePack === pack.id) {
    return { ok: false, error: `包 ${pack.id} 正在激活中，先 deactivate 再覆盖导入` }
  }
  writeJsonSafe(join(packsDir(), pack.id, 'hotpack.json'), pack)
  return { ok: true, pack: { id: pack.id, name: pack.name, version: pack.version, plugins: pack.plugins.length } }
}

async function previewPack(packId) {
  const manifest = readPackManifest(packId)
  if (manifest === null) return { ok: false, error: `未找到包：${packId}` }
  const state = readState()
  const refs = []
  for (const entry of manifest.plugins ?? []) {
    if (entry.source.type === 'npm') {
      const current = installedVersion(entry.name)
      refs.push({
        id: entry.id, name: entry.name, version: entry.version, source: 'npm',
        action: current === entry.version ? 'reused' : 'download',
        detail: current === entry.version
          ? `profile 已有 ${entry.name}@${entry.version}`
          : current === null
            ? `将从 npm registry 安装 ${entry.name}@${entry.version}`
            : `profile 现为 ${entry.name}@${current}，将替换为 ${entry.version}`,
      })
    } else if (entry.source.type === 'path') {
      const present = existsSync(join(entry.source.path, 'package.json'))
      refs.push({
        id: entry.id, name: entry.name, source: 'path',
        action: present ? 'reused' : 'error',
        detail: present ? `本地路径直接调用：${entry.source.path}` : `路径不存在或缺少 package.json：${entry.source.path}`,
      })
    } else {
      const present = existsSync(join(storeDirOf(entry), 'package.json'))
      refs.push({
        id: entry.id, name: entry.name, source: 'github',
        action: present ? 'reused' : 'download',
        detail: present
          ? `hotplug-store 已缓存 ${entry.name}@${entry.source.ref}`
          : `将从 GitHub 下载 ${entry.source.repo}@${entry.source.ref}（官方源 + 国内镜像）`,
      })
    }
  }
  return {
    ok: true,
    packId,
    wouldReplace: state.activePack && state.activePack !== packId ? state.activePack : null,
    refs,
  }
}

async function checkAsync() {
  const status = statusSync()
  const state = readState()
  let pnpmVersion = null
  try {
    const result = await runCli('pnpm', ['--version'], 5000, { shell: IS_WIN })
    if (result.code === 0) pnpmVersion = (result.stdout || '').trim()
  } catch {}
  const allPlugins = new Map()
  const conflicts = []
  for (const pack of status.packs) {
    for (const plugin of pack.plugins) {
      const key = plugin.name
      if (allPlugins.has(key)) {
        const prev = allPlugins.get(key)
        if (prev.version !== plugin.version) {
          conflicts.push({
            packId: pack.id,
            reason: plugin.name + ' 版本冲突 ' + (prev.version || '?') + ' vs ' + (plugin.version || '?'),
            suggest: '停用其中一个包或更新到同一版本',
          })
        }
      } else {
        allPlugins.set(key, plugin)
      }
    }
  }
  const manifest = readJson(manifestPath())
  const manifestOk = manifest !== null && typeof manifest === 'object'
  return {
    version: VERSION,
    nodeVersion: process.version,
    pnpmVersion,
    profile: { name: profileName(), dir: profileDir() },
    manifestOk,
    patchOk: status.activePatchOk,
    conflicts,
    activePack: state.activePack,
    packCount: status.packs.length,
    storeCount: status.store.entries.length,
    memoryDir: join(homeDir(), 'memory'),
  }
}

// ---------- Remote 网关 ----------

class HotplugGateway extends TypertRemoteService {
  chain = Promise.resolve()

  constructor(ctx) {
    super(ctx, 'dshHotplug')
    // 与 lib/typert.js、lib/client.js REMOTE.descriptors 三处同步。
    const methods = ['status', 'importPack', 'preview', 'activate', 'deactivate', 'removePack', 'check', 'marketList']
    for (const method of methods) {
      const decorator = Remote(method)
      decorator(HotplugGateway.prototype[method], {
        name: method,
        private: false,
        static: false,
        addInitializer: (initializer) => initializer.call(this),
      })
    }
  }

  /** 变更类操作串行化：同一时刻只动一次 profile。 */
  serialize(task) {
    const run = this.chain.then(task, task)
    this.chain = run.then(() => {}, () => {})
    return run
  }

  status() {
    return statusSync()
  }

  importPack(text) {
    return importPackSync(text)
  }

  preview(packId) {
    return previewPack(packId)
  }

  activate(packId) {
    return this.serialize(async () => {
      const manifest = readPackManifest(packId)
      if (manifest === null) return { ok: false, error: `未找到包：${packId}（先导入 hotpack）` }
      const state = readState()
      if (state.activePack === packId) return { ok: true, already: true, restartNeeded: false }
      const events = []
      if (state.activePack) {
        const previous = readPackManifest(state.activePack)
        if (previous !== null) {
          const unmounted = await unmountPack(previous)
          if (!unmounted.ok) return unmounted
          events.push(`已卸载上一个包：${previous.name ?? previous.id}（无损替换，记忆与 store 保留）`)
        }
      }
      const mounted = await mountPack(manifest)
      if (!mounted.ok) {
        // 挂载失败：把已经写进去的部分尽量还原（patch 块 + bundles），避免半挂载。
        removePatchBlock(manifest.id)
        removeBundles(bundlePkgNames(manifest))
        return { ok: false, error: mounted.error, steps: mounted.steps }
      }
      const next = readState()
      next.activePack = packId
      next.history = [...(next.history ?? []), { event: 'activate', packId, at: new Date().toISOString() }].slice(-64)
      writeState(next)
      return { ok: true, packId, steps: mounted.steps, events, restartNeeded: true }
    })
  }

  deactivate() {
    return this.serialize(async () => {
      const state = readState()
      if (!state.activePack) return { ok: false, error: '当前没有激活的包' }
      const manifest = readPackManifest(state.activePack)
      if (manifest !== null) {
        const unmounted = await unmountPack(manifest)
        if (!unmounted.ok) return unmounted
      } else {
        removePatchBlock(state.activePack)
      }
      const next = readState()
      next.history = [...(next.history ?? []), { event: 'deactivate', packId: state.activePack, at: new Date().toISOString() }].slice(-64)
      next.activePack = null
      writeState(next)
      return { ok: true, restartNeeded: true }
    })
  }

  removePack(packId) {
    return this.serialize(async () => {
      const state = readState()
      if (state.activePack === packId) return { ok: false, error: '不能移除激活中的包，先 deactivate' }
      if (readPackManifest(packId) === null) return { ok: false, error: `未找到包：${packId}` }
      rmSync(join(packsDir(), packId), { recursive: true, force: true })
      return { ok: true }
    })
  }

  check() {
    return checkAsync()
  }

  marketList(params) {
    return marketListAsync(params)
  }
}

export const name = 'dsh-hotplug-hub'
export const inject = []

export function apply(ctx) {
  // 空插座：不注册任何工具 / 预设 / 插件，只提供热插拔网关。
  new HotplugGateway(ctx)
}

export { HotplugGateway, parseHotpack, marketListAsync, extractIntro, extractInstall }
export default HotplugGateway
