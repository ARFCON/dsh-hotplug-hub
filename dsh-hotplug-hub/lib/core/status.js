/**
 * lib/core/status.js — 对外方法实现：状态 / 导入 / 预演 / 自检（v5 阶段 3 自 index.js 拆出）
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { VERSION, homeDir, packsDir, patchPath, profileDir, profileName, storeRoot } from './paths.js'
import { readJson, readPackManifest, listPackIds, readState, writeJsonSafe } from './state.js'
import { runCli } from './run-cli.js'
import { parseHotpack } from './hotpack.js'
import { installedVersion, npmModuleDir, storeDirOf } from './ensure.js'
import { findPatchBlock } from '../../vendor-shared/index.mjs'

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

export async function checkAsync() {
  const status = statusSync()
  const state = readState()
  let pnpmVersion = null
  try {
    const result = await runCli('pnpm', ['--version'], 5000)
    if (result.code === 0) pnpmVersion = (result.stdout || '').trim()
  } catch { /* 有意吞掉：尽力而为的清理/读取，失败不影响主流程 */ }
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
    memoryDir: join(homeDir(), 'memory-hub'),
  }
}
