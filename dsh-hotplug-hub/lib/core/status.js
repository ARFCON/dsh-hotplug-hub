/**
 * lib/core/status.js — 对外方法实现：状态 / 导入 / 预演 / 自检（v5 阶段 3 自 index.js 拆出）
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { VERSION, homeDir, memoryDir, packsDir, patchPath, profileDir, profileName, storeRoot } from './paths.js'
import { readJson, readPackManifest, listPackIds, readState, writeJsonSafe } from './state.js'
import { runCli } from './run-cli.js'
import { parseHotpack } from './hotpack.js'
import { installedVersion, isNpmCached, storeDirOf } from './ensure.js'
import { findPatchBlock } from '../../vendor-shared/index.mjs'

/** 取某包「最近一次」activate 事件的时间戳（反向遍历，避免 find 命中历史里最早一次激活）。
 *  审计修复：此前 `state.history?.find?.(...)?.at` 只取第一次 activate——包经历
 *  激活→卸载→再激活后，activatedAt 返回的是最早那次，属陈旧数据；且 `?.at` 与
 *  Array.prototype.at 同名易误读。 */
function lastActivationAt(state, id) {
  const history = Array.isArray(state?.history) ? state.history : []
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i]
    if (item && item.packId === id && item.event === 'activate') {
      return typeof item.at === 'string' ? item.at : null
    }
  }
  return null
}

export function statusSync() {
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
      activatedAt: lastActivationAt(state, id),
      plugins: (manifest.plugins ?? []).map((entry) => {
        const dir = storeDirOf(entry)
        const present = existsSync(join(dir, 'package.json'))
        return {
          id: entry.id,
          name: entry.name,
          version: entry.version ?? null,
          source: entry.source.type,
          path: dir,
          // npm cached 走单一真源 isNpmCached（版本 + 内部包名双校验，与 ensureNpm reused 一致）；
          // 非 npm（path/github）按落地 package.json 存在性判定。
          cached: entry.source.type === 'npm' ? isNpmCached(entry.name, entry.version) : present,
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
  } catch { /* 有意吞掉：尽力而为的清理/读取，失败不影响主流程 */ }
  const patchText = existsSync(patchPath()) ? readFileSync(patchPath(), 'utf8') : ''
  return {
    version: VERSION,
    home: homeDir(),
    profile: { name: profileName(), dir: profileDir() },
    activePack: state.activePack ?? null,
    // 审计修复：改用 shared findPatchBlock（识别 `#`/`##` 两种 marker 形态）——
    // 此前 includes('## hotplug:<id>') 对旧单 # marker 误报 activePatchOk=false。
    activePatchOk: state.activePack ? findPatchBlock(patchText, 'hotplug', state.activePack).found : true,
    packs,
    store: { dir: storeRoot(), entries: storeEntries },
    memoryDir: memoryDir(),
  }
}

export function importPackSync(input) {
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

export async function previewPack(packId) {
  const manifest = readPackManifest(packId)
  if (manifest === null) return { ok: false, error: `未找到包：${packId}` }
  const state = readState()
  const refs = []
  for (const entry of manifest.plugins ?? []) {
    if (entry.source.type === 'npm') {
      const current = installedVersion(entry.name)
      // 审计修复：reused 判定走单一真源 isNpmCached（版本 + 内部包名双校验，与
      // ensureNpm/statusSync 一致）——串包（name 不符、版本巧合相同）不得误报 reused。
      const reused = isNpmCached(entry.name, entry.version)
      refs.push({
        id: entry.id, name: entry.name, version: entry.version, source: 'npm',
        action: reused ? 'reused' : 'download',
        detail: reused
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

/** 插件「同实体」指纹：源类型 + 版本/落地路径（github 的 path=storeDir 已含 ref）。 */
function pluginFingerprint(plugin) {
  if (plugin.source === 'npm') return `npm@${plugin.version ?? ''}`
  if (plugin.source === 'github') return `github@${plugin.path ?? ''}`
  return `path@${plugin.path ?? ''}`
}

/** 从 github storeDir（`<name>@<ref>`）提取 ref（ref 字符集无 @，lastIndexOf 可靠）。 */
function refOf(plugin) {
  const s = String(plugin.path ?? '')
  const i = s.lastIndexOf('@')
  return i >= 0 ? s.slice(i + 1) : '?'
}

/** 按差异类型生成冲突原因（版本 / 引用 / 路径 / 源类型），不再一律「版本冲突」。 */
function conflictReason(name, a, b) {
  if (a.source === 'npm' && b.source === 'npm') {
    return `${name} 版本冲突 ${a.version || '?'} vs ${b.version || '?'}`
  }
  if (a.source === 'github' && b.source === 'github') {
    return `${name} github 引用冲突 ${refOf(a)} vs ${refOf(b)}`
  }
  if (a.source === 'path' && b.source === 'path') {
    return `${name} 路径冲突 ${a.path} vs ${b.path}`
  }
  return `${name} 源类型冲突 ${a.source} vs ${b.source}`
}

export async function checkAsync() {
  const status = statusSync()
  const state = readState()
  let pnpmVersion = null
  try {
    const result = await runCli('pnpm', ['--version'], 5000)
    if (result.code === 0) pnpmVersion = (result.stdout || '').trim()
  } catch { /* 有意吞掉：尽力而为的清理/读取，失败不影响主流程 */ }
  // 审计修复：冲突判定不再只比 version——github/path 源 version 恒为 null，同名不同
  // ref/路径的插件被漏报；npm vs 非 npm 同名又被误报为「版本冲突」。现按「源类型 + 版本 +
  // 落地路径」指纹判同：指纹不同（同名字符串）即冲突，reason 按差异类型区分。
  const allPlugins = new Map()
  const conflicts = []
  for (const pack of status.packs) {
    for (const plugin of pack.plugins) {
      const key = String(plugin.name).toLowerCase()
      const fingerprint = pluginFingerprint(plugin)
      if (allPlugins.has(key)) {
        const prev = allPlugins.get(key)
        if (prev.fingerprint !== fingerprint) {
          conflicts.push({ packId: pack.id, reason: conflictReason(plugin.name, prev, plugin), suggest: '停用其中一个包或统一版本/来源' })
        }
      } else {
        allPlugins.set(key, { ...plugin, fingerprint })
      }
    }
  }
  const manifest = readJson(join(profileDir(), 'package.json'))
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
    memoryDir: memoryDir(),
  }
}
