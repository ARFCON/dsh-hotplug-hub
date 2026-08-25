/**
 * lib/core/state.js — 文件工具 + 中枢状态（v5 阶段 3 自 index.js 拆出）
 *
 * 写盘统一走 vendor-shared fs/atomic（随机 tmp + O_EXCL + fsync + rename）——
 * 审计修复（M-44）：此前 writeTextSafe 用固定 `${path}.tmp` + rmSync→renameSync 且无锁，
 * 多进程并发写同一文件时 ENOENT/EPERM 竞态；历史 .bak 无任何消费者，一并移除。
 *
 * 审计修复（R3，信任边界）：readPackManifest 只做 PACK_ID_RE + JSON.parse，磁盘
 * manifest（可篡改输入）不经过 parseHotpack 权威校验就进入激活/预演/状态路径——
 * 篡改的 plugin name/version/repo 直接进 pnpm spec 与 profile package.json。
 * 现 loadPackManifest 统一复验（missing / invalid / ok 三态），消费点全部切换。
 *
 * 审计修复（R3，损坏语义）：readJson 把一切错误吞成 null——state.json 损坏被当成
 * 全新状态，下一次 writeState 覆盖后 activePack/activeInstall 永久孤儿化。现
 * readState 区分「缺失」（默认状态）与「损坏」（corrupted 标记），statusSync 显式
 * stateOk，变更类操作见 gateway（拒绝在损坏状态上变更）。
 */
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync,
  renameSync, rmdirSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { PACK_ID_RE, writeFileAtomic } from '../../vendor-shared/index.mjs'
import { packsDir, statePath } from './paths.js'
import { parseHotpack } from './hotpack.js'

// writeFileAtomic 契约所需 fs 端口（与 ai-session.js 的 atomicFsPort 一致）。
const atomicFsPort = {
  mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, existsSync, unlinkSync,
}

export function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

/**
 * 读 JSON 并区分三态（R3）：missing（不存在）/ invalid（存在但读/解析失败或非对象
 * 上下文由调用方判定）/ ok。invalid 的判定只覆盖「文件存在但内容坏」；上层语义
 * （如 state 的形状校验）由调用方在 ok 之上追加。
 * @returns {{status: 'missing'|'invalid'|'ok', value?: any}}
 */
export function readJsonStatus(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    if (e && e.code === 'ENOENT') return { status: 'missing' }
    return { status: 'invalid' }
  }
  try {
    return { status: 'ok', value: JSON.parse(text) }
  } catch {
    return { status: 'invalid' }
  }
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
  const r = readJsonStatus(statePath())
  if (r.status === 'missing') return { version: 1, activePack: null, history: [] }
  if (r.status === 'ok' && r.value && typeof r.value === 'object' && !Array.isArray(r.value)) {
    return r.value
  }
  // 损坏（半截 JSON / 非对象形状 / 读取失败）：不信任其中任何字段；corrupted 标记
  // 供 statusSync（stateOk）与 gateway（变更拒绝）消费。绝不静默当全新状态覆盖。
  return { version: 1, activePack: null, history: [], corrupted: true }
}
export function writeState(state) {
  writeJsonSafe(statePath(), { ...state, updatedAt: new Date().toISOString() })
}

/**
 * 读取磁盘 manifest（兼容出口）：先经 loadPackManifest 权威复验，通过才返回
 * 【磁盘原始 JSON】（含 memory 等展示附加字段，loadPackManifest 的规范化产物会
 * 丢弃它们）；无效/缺失一律 null。审查修复：此前是无校验的裸读——正是本审计
 * 废弃的绕过面，现收敛为「校验后的原始形态透出」，不再有无校验路径。
 */
export function readPackManifest(packId) {
  const loaded = loadPackManifest(packId)
  if (loaded.status !== 'ok') return null
  return readJson(join(packsDir(), packId, 'hotpack.json'))
}

/**
 * 读取并【权威复验】磁盘 manifest（R3 信任边界修复）。
 * packs/<id>/hotpack.json 是磁盘上的可篡改输入：name/version/repo 若不校验就进
 * pnpm spec（经 cmd.exe 包装）与 profile package.json，所有白名单正则失效。
 * 与 importPackSync 同一权威解析（core/hotpack 适配层），往返（adapt 产物含
 * memory/tags 截断）可复验——parseHotpack 忽略未知顶层字段且字段均为合法值。
 * 三态区分「不存在」与「存在但损坏」（半截 JSON / 读取失败）——审查修复：此前
 * 损坏 JSON 被 readJson 吞成 missing，激活/预演误报「未找到包」而非「清单损坏」。
 * @param {string} packId
 * @returns {{status: 'missing'|'invalid'|'ok', pack?: object, code?: string, error?: string}}
 */
export function loadPackManifest(packId) {
  if (typeof packId !== 'string' || !PACK_ID_RE.test(packId)) return { status: 'missing' }
  const r = readJsonStatus(join(packsDir(), packId, 'hotpack.json'))
  if (r.status === 'missing') return { status: 'missing' }
  if (r.status === 'invalid') {
    return { status: 'invalid', code: 'ERR_ASSEMBLY_INVALID_JSON', error: 'hotpack.json 不是合法 JSON 或不可读（文件可能损坏，请重新导入）' }
  }
  const parsed = parseHotpack(r.value)
  if (!parsed.ok) return { status: 'invalid', code: parsed.code, error: parsed.error }
  return { status: 'ok', pack: parsed.pack }
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

/** packs/<id> 目录是否存在（removePack 的存在性判定——损坏包也允许删除恢复）。
 *  审计修复（Windows 大小写）：NTFS 大小写不敏感——loadPackManifest 经 FS 可命中
 *  大小写变体（activate('PACK.X') 能读到 pack.x 的清单），此处若严格比对则 removePack
 *  误报「未找到包」。Windows 下按小写比对（与 NTFS 语义一致），POSIX 保持精确。 */
export function packDirExists(packId) {
  if (typeof packId !== 'string' || !PACK_ID_RE.test(packId)) return false
  const want = process.platform === 'win32' ? packId.toLowerCase() : packId
  try {
    return readdirSync(packsDir(), { withFileTypes: true })
      .some((entry) => {
        if (!entry.isDirectory()) return false
        return process.platform === 'win32' ? entry.name.toLowerCase() === want : entry.name === want
      })
  } catch {
    return false
  }
}
