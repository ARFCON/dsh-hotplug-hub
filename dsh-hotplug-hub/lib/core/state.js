/**
 * lib/core/state.js — 文件工具 + 中枢状态（v5 阶段 3 自 index.js 拆出）
 *
 * 注：writeTextSafe 的历史 .bak 语义保留（兼容既有行为）；阶段 4 将随
 * 「分节合并 + 统一原子写」迁移到 vendor-shared fs/atomic（M-44）。
 */
import {
  copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { PACK_ID_RE } from '../../vendor-shared/index.mjs'
import { packsDir, statePath } from './paths.js'

export function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}
export function writeTextSafe(path, text) {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, text, 'utf8')
  try { copyFileSync(path, `${path}.bak`) } catch { /* 有意吞掉：尽力而为的清理/读取，失败不影响主流程 */ }
  try { rmSync(path, { force: true }) } catch { /* 有意吞掉：尽力而为的清理/读取，失败不影响主流程 */ }
  renameSync(tmp, path)
}
export function writeJsonSafe(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeTextSafe(path, JSON.stringify(value, null, 2) + '\n')
}

export function readState() {
  const state = readJson(statePath())
  return state && typeof state === 'object' ? state : { version: 1, activePack: null, history: [] }
}
export function writeState(state) {
  writeJsonSafe(statePath(), { ...state, updatedAt: new Date().toISOString() })
}

export function readPackManifest(packId) {
  if (typeof packId !== 'string' || !PACK_ID_RE.test(packId)) return null
  return readJson(join(packsDir(), packId, 'hotpack.json'))
}
export function listPackIds() {
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
