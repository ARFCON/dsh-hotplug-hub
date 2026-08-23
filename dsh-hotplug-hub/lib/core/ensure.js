/**
 * lib/core/ensure.js — 插件解析：有就直接调用，缺了才下（v5 阶段 3 自 index.js 拆出）
 *
 * M-39（v5 阶段 1）：GitHub 解包后整树 realpath 校验（zip slip + 符号链接成员拒绝）。
 */
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { assertWithinRealpath } from '../../vendor-shared/index.mjs'
import { CURL_BIN, DOWNLOAD_TIMEOUT_MS, ENSURE_TIMEOUT_MS, GITHUB_MIRRORS, IS_WIN, TAR_BIN, profileDir, storeRoot } from './paths.js'
import { readJson } from './state.js'
import { runCli, tail } from './run-cli.js'

export function npmModuleDir(pkgName) {
  return join(profileDir(), 'node_modules', ...pkgName.split('/'))
}

/**
 * 把含 '/' 的 ref（H-10 起允许 feature/x）编码为单段文件名，避免与 `<name>@<ref>`
 * 平铺键拼出层级目录：ref 'feature' 与 'feature/x' 若原样拼进路径会形成父子目录，
 * ensureGithub 的 rmSync(dest, {recursive:true}) 会连带删除兄弟 ref 的缓存（数据丢失）。
 * '%' 不在 name（PLUGIN_NAME_RE）与 ref（validateSourceRef 字符集 [0-9A-Za-z._-/]）中，
 * 故 '%2F' 编码无碰撞、可逆；scoped 插件名 '@scope/name' 的 '/' 同理编码，保证
 * store 键恒为单段（裸 '@scope' 永不成为缓存目标，纯父目录不会造成数据丢失）。
 * @param {string} token name 或 ref（可能含 '/'）
 * @returns {string} 单段安全文件名
 */
export function storeKeySegment(token) {
  return String(token ?? '').replace(/\//g, '%2F')
}

export function storeDirOf(entry) {
  if (entry.source.type === 'github') return join(storeRoot(), `${storeKeySegment(entry.name)}@${storeKeySegment(entry.source.ref)}`)
  if (entry.source.type === 'path') return entry.source.path
  return npmModuleDir(entry.name)
}
export function installedVersion(pkgName) {
  const meta = readJson(join(npmModuleDir(pkgName), 'package.json'))
  return meta && typeof meta.version === 'string' ? meta.version : null
}
export function innerPackageName(dir) {
  const meta = readJson(join(dir, 'package.json'))
  return meta && typeof meta.name === 'string' ? meta.name : null
}

export async function ensureNpm(entry) {
  const current = installedVersion(entry.name)
  // 审计修复：reused 判定补齐包名校验（与 ensurePath/ensureGithub 一致）——只比对版本
  // 会放过 node_modules/<name> 下包名被篡改/串包但版本巧合相同的残留包，直接复用。
  if (current === entry.version && innerPackageName(npmModuleDir(entry.name)) === entry.name) {
    return { ok: true, status: 'reused', path: npmModuleDir(entry.name), detail: `profile 已有 ${entry.name}@${entry.version}，直接调用` }
  }
  const spec = `${entry.name}@${entry.version}`
  // R-v5-17（v5 阶段 1）：安装脚本 RCE 纵深防御——默认 --ignore-scripts，
  // DSH_ALLOW_INSTALL_SCRIPTS=1 显式放行（依赖 install scripts 的合法插件需放行）
  const args = ['add', '--save-exact']
  if (process.env.DSH_ALLOW_INSTALL_SCRIPTS !== '1') args.push('--ignore-scripts')
  args.push(spec)
  const result = await runCli('pnpm', args, ENSURE_TIMEOUT_MS)
  const after = installedVersion(entry.name)
  if (result.code === 0 && after === entry.version) {
    return { ok: true, status: current === null ? 'downloaded' : 'replaced', path: npmModuleDir(entry.name), detail: `pnpm add ${spec} 完成` }
  }
  // 审计修复：区分「pnpm 退出非 0」与「退出 0 但版本不符」——后者此前误报「失败（exit 0）」。
  const reason = result.code === 0
    ? `pnpm add ${spec} 未得到预期版本（期望 ${entry.version}，实际 ${after ?? '无 package.json/version'}）`
    : `pnpm add ${spec} 失败（exit ${result.code}）：${tail(result.stderr || result.stdout)}`
  return { ok: false, status: 'error', error: reason }
}

export async function ensurePath(entry) {
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

export function githubZipUrls(repo, ref) {
  const base = `https://codeload.github.com/${repo}/zip/refs`
  const direct = [`${base}/heads/${ref}`, `${base}/tags/${ref}`]
  const mirrored = []
  for (const mirror of GITHUB_MIRRORS) {
    mirrored.push(`${mirror}${base}/heads/${ref}`, `${mirror}${base}/tags/${ref}`)
  }
  return [...direct, ...mirrored]
}

export async function downloadZip(url, zipPath) {
  const args = ['-fSL', '--retry', '1', '--max-time', '110', '-o', zipPath, url]
  if (IS_WIN) args.splice(1, 0, '--ssl-no-revoke')
  const result = await runCli(CURL_BIN, args, DOWNLOAD_TIMEOUT_MS, { cwd: tmpdir() })
  return result.code === 0 && existsSync(zipPath)
}

/**
 * M-39（v5 阶段 1）：解包后整树安全校验——zip slip + 符号链接成员。
 * 逐项 lstat 遍历：符号链接目标的 realpath 必须仍在解包根内（拒绝逃逸）；
 * 普通条目经 assertWithinRealpath 校验（含最深已存在祖先解析）。
 * @param {string} extractDir 解包根（绝对路径）
 * @returns {string|null} 违规描述；null=通过
 */
export function verifyExtractedTree(extractDir) {
  const stack = [extractDir]
  const seen = new Set()
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (e) {
      return `解包目录读取失败 ${dir}：${e.message}`
    }
    for (const ent of entries) {
      const abs = join(dir, ent.name)
      if (seen.has(abs)) continue
      seen.add(abs)
      if (ent.isSymbolicLink()) {
        // 符号链接成员：真实目标必须仍在解包根内
        let real
        try {
          real = realpathSync(abs)
        } catch (e) {
          return `解包符号链接不可解析 ${abs}：${e.message}`
        }
        const within = assertWithinRealpath({ existsSync, realpathSync }, extractDir, real, `解包符号链接 ${abs}`)
        if (!within.ok) return `解包符号链接越界 ${abs} → ${real}`
      } else if (ent.isDirectory()) {
        stack.push(abs)
      } else if (ent.isFile()) {
        const within = assertWithinRealpath({ existsSync, realpathSync }, extractDir, abs, `解包文件 ${abs}`)
        if (!within.ok) return `解包条目越界 ${abs}`
      }
    }
  }
  return null
}

export async function ensureGithub(entry) {
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
      try { rmSync(zipPath, { force: true }) } catch { /* 有意吞掉：尽力而为的清理/读取，失败不影响主流程 */ }
      if (await downloadZip(url, zipPath)) { downloaded = true; break }
    }
    if (!downloaded) return { ok: false, status: 'error', error: `GitHub 下载失败：${entry.source.repo}@${entry.source.ref}（已尝试官方源与国内镜像）` }
    let extract = await runCli(TAR_BIN, ['-xf', zipPath, '-C', extractDir], DOWNLOAD_TIMEOUT_MS)
    if (extract.code !== 0 && process.platform === 'linux') {
      extract = await runCli('unzip', ['-q', zipPath, '-d', extractDir], DOWNLOAD_TIMEOUT_MS)
    }
    if (extract.code !== 0) return { ok: false, status: 'error', error: `解压失败：${tail(extract.stderr)}` }
    // M-39：解包后整树校验（zip slip + 符号链接成员逃逸一律拒绝）
    const treeIssue = verifyExtractedTree(extractDir)
    if (treeIssue !== null) return { ok: false, status: 'error', error: `解包内容不安全：${treeIssue}` }
    const roots = readdirSync(extractDir)
    const root = roots.length === 1 ? join(extractDir, roots[0]) : extractDir
    // root 选择本身也必须过 realpath 越界校验（单根目录可能是符号链接）
    const rootCheck = assertWithinRealpath({ existsSync, realpathSync }, extractDir, root, 'GitHub 包根')
    if (!rootCheck.ok) return { ok: false, status: 'error', error: `解包根越界：${rootCheck.error.message}` }
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
    try { rmSync(zipPath, { force: true }) } catch { /* 有意吞掉：尽力而为的清理/读取，失败不影响主流程 */ }
    try { rmSync(extractDir, { recursive: true, force: true }) } catch { /* 有意吞掉：尽力而为的清理/读取，失败不影响主流程 */ }
  }
}

export async function ensureEntry(entry) {
  if (entry.source.type === 'npm') return ensureNpm(entry)
  if (entry.source.type === 'path') return ensurePath(entry)
  return ensureGithub(entry)
}
