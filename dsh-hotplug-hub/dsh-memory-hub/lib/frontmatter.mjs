/**
 * dsh-memory-hub / lib/frontmatter.mjs — 条目 Markdown frontmatter 的子集读写（零依赖）。
 *
 * 我们完全控制写入，所以用一个紧凑的「key: value」多行格式；读取时只解析
 * 该格式（容忍手改掉的简单标量/字符串数组）。不引 YAML 依赖。解析失败走
 * InvalidInputError（失败要大声），绝不静默返回半解析态。
 */
import { InvalidInputError } from './errors.mjs'

/**
 * 把条目元数据字段序列化为 frontmatter 文本（不含 `---` 包裹符）。
 * @param {Record<string, unknown>} fields
 * @returns {string}
 */
export function stringifyFrontmatter(fields) {
  const lines = []
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue
    lines.push(`${key}: ${encodeValue(value)}`)
  }
  return lines.join('\n')
}

/**
 * 单值编码：字符串加引号（含特殊字符）；字符串数组展开多行；标量原样。
 */
function encodeValue(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stringifyScalar(item)).join(', ')}]`
  }
  return stringifyScalar(value)
}

function stringifyScalar(value) {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(String(value))
}

/**
 * 解析 frontmatter 块文本为字段对象。
 * 只支持本插件写出的扁平「key: scalar|array」集；遇到不可解析行抛 InvalidInputError。
 * @param {string} text
 * @returns {Record<string, unknown>}
 */
export function parseFrontmatter(text) {
  /** @type {Record<string, unknown>} */
  const fields = {}
  const lines = String(text).split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (line.trim() === '') continue
    const match = /^([A-Za-z][A-Za-z0-9]*)\s*:\s?(.*)$/.exec(line.trim())
    if (match === null) {
      throw new InvalidInputError(`frontmatter 第 ${index + 1} 行无法解析：${line}`)
    }
    const key = match[1]
    const raw = match[2]
    fields[key] = decodeValue(raw, key)
  }
  return fields
}

function decodeValue(raw, key) {
  const trimmed = raw.trim()
  if (trimmed === '') return ''
  // 数组：[a, b, c]
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim()
    if (inner === '') return []
    // 用引号感知切分：',' 分割，引号内不切。
    return splitQuoted(inner).map((part) => decodeScalar(part.trim(), key))
  }
  return decodeScalar(trimmed, key)
}

function splitQuoted(text) {
  /** @type {string[]} */
  const parts = []
  let current = ''
  let inQuote = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (char === '"') {
      inQuote = !inQuote
      current += char
    } else if (char === ',' && !inQuote) {
      parts.push(current)
      current = ''
    } else {
      current += char
    }
  }
  parts.push(current)
  return parts
}

function decodeScalar(raw, key) {
  const text = raw.trim()
  // 引号字符串
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      return /** @type {string} */ (JSON.parse(text))
    } catch (error) {
      throw new InvalidInputError(`字段 ${key} 的字符串非法：${raw}（${String(error.message ?? error)}）`)
    }
  }
  if (text === 'true') return true
  if (text === 'false') return false
  if (text === 'null') return null
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text)
  // 裸字符串（未引号）——兼容手改。
  return text
}
