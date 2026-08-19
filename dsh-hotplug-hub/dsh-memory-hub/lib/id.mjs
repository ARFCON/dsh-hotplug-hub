/**
 * dsh-memory-hub / lib/id.mjs — 条目 ID 生成与校验（零依赖，node:crypto）。
 */
import { randomBytes } from 'node:crypto'
import { LEGACY_ID_RE } from './constants.mjs'

/** 生成 mem-<16hex>（crypto 随机），不可变。 */
export function newMemoryId() {
  return `mem-${randomBytes(8).toString('hex')}`
}

/** 生成 revision 目录文件名用的序号（>=10 前缀，排序友好）。 */
export function revisionFileName(revision) {
  return String(revision).padStart(3, '0') + '.md'
}

/** 校验任意引用/ID 是否为合法条目 ID（mem- 或 legacy-）。 */
export function isEntryId(value) {
  if (typeof value !== 'string') return false
  return /^mem-[0-9a-f]{16}$/.test(value) || LEGACY_ID_RE.test(value)
}
