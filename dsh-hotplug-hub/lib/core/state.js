/**
 * lib/core/state.js — 文件工具 + 中枢状态（v5 阶段 3 自 index.js 拆出）
 *
 * 写盘统一走 vendor-shared fs/atomic（随机 tmp + O_EXCL + fsync + rename）——
 * 审计修复（M-44）：此前 writeTextSafe 用固定 `${path}.tmp` + rmSync→renameSync 且无锁，
 * 多进程并发写同一文件时 ENOENT/EPERM 竞态；历史 .bak 无任何消费者，一并移除。
 */
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync,
  renameSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { PACK_ID_RE, writeFileAtomic } from '../../vendor-shared/index.mjs'
import { packsDir, statePath } from './paths.js'

// writeFileAtomic 契约所需 fs 端口（与 ai-session.js 的 atomicFsPort 一致）
const atomicFsPort = {
  mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, existsSync, unlinkSync,
}

export function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}
export function writeTextSafe(path, text) {
  const r = writeFileAtomic(atomicFsPort, path, text, { errorCode: 'ERR_LOG_WRITE' })
  if (!r.ok) throw r.error
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
