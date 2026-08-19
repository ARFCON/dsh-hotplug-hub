// test/conformance.test.mjs — dsh-memory-protocol v1 一致性套件。
// 黄金参考：schema/dsh-memory-protocol-v1.schema.json。用内置迷你 validator
// 校验协议 fixture（记忆包 / 条目 / 写意图 / 提案 / 检索结果 / 审计行）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const schema = JSON.parse(readFileSync(join(HERE, '..', 'schema', 'dsh-memory-protocol-v1.schema.json'), 'utf8'))

// ---------- 迷你 validator（覆盖本 schema 用到的子集） ----------

function resolveRef(ref, root) {
  const path = ref.replace(/^#\/?/, '').split('/').filter(Boolean)
  let node = root
  for (const part of path) node = node[part]
  return node
}

/** 校验：返回错误数组（空=通过）。 */
function validate(value, subschema, root, path = '') {
  if (subschema === undefined || subschema === null) return [`${path}: 空 subschema`]
  if (subschema.$ref) {
    const target = resolveRef(subschema.$ref, root)
    if (target === undefined) return [`${path}: 无法解析 $ref ${subschema.$ref}`]
    return validate(value, target, root, path)
  }
  if ('const' in subschema) {
    if (value !== subschema.const) return [`${path}: 期望 const ${subschema.const}，实得 ${JSON.stringify(value)}`]
    return []
  }
  if ('enum' in subschema) {
    if (!subschema.enum.includes(value)) return [`${path}: 期望 enum ${subschema.enum.join('|')}，实得 ${JSON.stringify(value)}`]
    return []
  }
  if (subschema.anyOf) {
    for (const alt of subschema.anyOf) {
      if (validate(value, alt, root, path).length === 0) return []
    }
    return [`${path}: 不满足 anyOf`]
  }
  if (subschema.oneOf) {
    const pass = subschema.oneOf.filter((alt) => validate(value, alt, root, path).length === 0).length
    if (pass !== 1) return [`${path}: 必须恰好满足 oneOf 之一（当前 ${pass} 个满足）`]
    return []
  }
  const errors = []
  if (subschema.type) {
    const types = Array.isArray(subschema.type) ? subschema.type : [subschema.type]
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
    const ok = types.includes(actual) || (types.includes('integer') && Number.isInteger(value))
    if (!ok) return [`${path}: 期望类型 ${types.join('|')}，实得 ${actual}`]
  }
  if (typeof value === 'string') {
    if (Number.isInteger(subschema.maxLength) && value.length > subschema.maxLength) {
      errors.push(`${path}: 超过 maxLength ${subschema.maxLength}`)
    }
    if (subschema.pattern && !new RegExp(subschema.pattern, 'u').test(value)) {
      errors.push(`${path}: 不匹配 pattern ${subschema.pattern}（值 ${JSON.stringify(value)}）`)
    }
  }
  if (typeof value === 'number') {
    if (Number.isFinite(subschema.minimum) && value < subschema.minimum) errors.push(`${path}: 小于 minimum ${subschema.minimum}`)
    if (Number.isFinite(subschema.maximum) && value > subschema.maximum) errors.push(`${path}: 大于 maximum ${subschema.maximum}`)
  }
  if (Array.isArray(value)) {
    if (subschema.maxItems !== undefined && value.length > subschema.maxItems) errors.push(`${path}: 超过 maxItems ${subschema.maxItems}`)
    if (subschema.items) {
      value.forEach((item, index) => {
        errors.push(...validate(item, subschema.items, root, `${path}[${index}]`))
      })
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if (subschema.required) {
      for (const key of subschema.required) {
        if (!(key in value)) errors.push(`${path}: 缺 required 字段 ${key}`)
      }
    }
    if (subschema.properties) {
      for (const [key, propSchema] of Object.entries(subschema.properties)) {
        if (key in value) errors.push(...validate(value[key], propSchema, root, `${path}.${key}`))
      }
    }
    if (subschema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(subschema.properties && key in subschema.properties)) errors.push(`${path}: 有多余字段 ${key}`)
      }
    }
  }
  return errors
}

function assertValid(fixture, title) {
  const errors = validate(fixture, schema, schema)
  assert.deepEqual(errors, [], `${title} 应通过校验；错误：${errors.join('; ')}`)
}

// ---------- 黄金 fixtures ----------

const entryFixture = {
  id: 'mem-1234567890abcdef',
  revision: 3,
  createdAt: '2026-08-19T00:00:00.000Z',
  updatedAt: '2026-08-19T01:00:00.000Z',
  name: 'dsh-plugin-build-rule',
  title: 'DSH 插件构建规则',
  description: '插件包用 dev_build_plugin 构建',
  type: 'project',
  scope: 'global',
  activation: 'relevant',
  volatility: 'stable',
  subjectKey: 'dsh.build_plugin',
  expiresAt: null,
  lastVerifiedAt: null,
  keywords: ['构建', 'build'],
  tagged: ['[id: mem-1234567890abcdef]'],
  body: '插件生产线。',
}

const packFixture = {
  memoryPackId: 'global-pack',
  scope: 'global',
  schemaVersion: 1,
  keywords: ['构建', '用户'],
  entries: 1,
  createdAt: '2026-08-19T00:00:00.000Z',
}

const writeIntentFixture = {
  action: 'create',
  packId: 'global-pack',
  entry: entryFixture,
  reason: 'memory.commit',
}

const proposalFixture = {
  id: 'p-1750000000000-ab12cd',
  packId: 'global-pack',
  status: 'pending',
  kind: 'create',
  entry: entryFixture,
  reason: 'AI 建议',
  createdAt: '2026-08-19T00:00:00.000Z',
  resolvedAt: null,
}

const searchResultFixture = {
  query: '构建',
  pack: 'global-pack',
  hits: [{
    id: 'mem-1234567890abcdef',
    name: 'dsh-plugin-build-rule',
    packId: 'global-pack',
    title: 'DSH 插件构建规则',
    freshness: 'fresh',
    score: 3.14,
    matched: ['构建'],
  }],
  count: 1,
  warning: '[memory: 不可信声明]',
}

test('协议 fixture 全通过 schema 校验', () => {
  assertValid({ schemaVersion: 1, protocol: 'dsh-memory-protocol', memoryPack: packFixture }, 'memoryPack')
  assertValid({ schemaVersion: 1, protocol: 'dsh-memory-protocol', memoryEntry: entryFixture }, 'memoryEntry')
  assertValid({ schemaVersion: 1, protocol: 'dsh-memory-protocol', writeIntent: writeIntentFixture }, 'writeIntent')
  assertValid({ schemaVersion: 1, protocol: 'dsh-memory-protocol', proposal: proposalFixture }, 'proposal')
  assertValid({ schemaVersion: 1, protocol: 'dsh-memory-protocol', searchResult: searchResultFixture }, 'searchResult')
})

test('非法 fixture 被拒绝（坏 id / 坏枚举 / 缺 required / 坏 pattern）', () => {
  const badEntry = { ...entryFixture, id: 'not-an-id' }
  assert.equal(validate(badEntry, schema.properties.memoryEntry, schema).length > 0, true, '坏 id 不应通过')
  const badEnum = { ...entryFixture, type: 'nonsense' }
  assert.equal(validate(badEnum, schema.properties.memoryEntry, schema).length > 0, true, '坏 type 不应通过')
  const missing = { ...entryFixture }
  delete missing.name
  assert.equal(validate(missing, schema.properties.memoryEntry, schema).length > 0, true, '缺 name 不应通过')
  const badPack = { ...packFixture, memoryPackId: 'Bad Pack!' }
  assert.equal(validate(badPack, schema.properties.memoryPack, schema).length > 0, true, '坏 packId 不应通过')
  const badSubject = { ...entryFixture, subjectKey: 'UPPER case!' }
  assert.equal(validate(badSubject, schema.properties.memoryEntry, schema).length > 0, true, '坏 subjectKey 不应通过')
})
