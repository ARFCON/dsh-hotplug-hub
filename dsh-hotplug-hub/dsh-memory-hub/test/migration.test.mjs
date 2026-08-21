// test/migration.test.mjs — C2（兼容性审计）：旧 memory 目录 → memory-hub 软链迁移
// §9 承诺："旧 memory 目录迁移到 memory-hub（或软链），不丢数据（含 memories.jsonl 兼容）"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, lstatSync, symlinkSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../lib/store.mjs'

function tempRoot(prefix = 'mh-migrate-') {
  const root = mkdtempSync(join(tmpdir(), prefix))
  return { root, cleanup: () => { try { rmSync(root, { recursive: true, force: true }) } catch { /* ok */ } } }
}

test('C2：hubDir 缺失且同级 legacy memory 存在 → 建链接迁移，数据原址保留', () => {
  const { root, cleanup } = tempRoot()
  try {
    const legacy = join(root, 'memory')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'memories.jsonl'), '{"type":"doc-read","doc":"a.md"}\n')
    const hubDir = join(root, 'memory-hub')

    const store = new MemoryStore(hubDir)
    assert.equal(existsSync(hubDir), true, 'memory-hub 已建立')
    assert.equal(lstatSync(hubDir).isSymbolicLink(), true, 'memory-hub 是链接（junction/symlink）形态')
    // 数据原址保留：legacy 目录未被移动/删除；memories.jsonl 经新路径可读
    assert.equal(existsSync(legacy), true, 'legacy memory 目录仍在')
    assert.equal(readFileSync(join(hubDir, 'memories.jsonl'), 'utf8'), '{"type":"doc-read","doc":"a.md"}\n', 'legacy 数据经 memory-hub 路径可读')
    // 经链接写入：hub 正常创建包结构
    store.createPack({ memoryPackId: 'p1', scope: 'global', keywords: [] })
    assert.equal(existsSync(join(legacy, 'p1', 'pack.json')), true, '新写入落在 legacy 目录内（同一存储）')
    assert.equal(store.hasPack('p1'), true)
  } finally {
    cleanup()
  }
})

test('C2：hubDir 缺失且无 legacy → 普通新建（无链接）', () => {
  const { root, cleanup } = tempRoot()
  try {
    const hubDir = join(root, 'memory-hub')
    const store = new MemoryStore(hubDir)
    assert.equal(existsSync(hubDir), true)
    assert.equal(lstatSync(hubDir).isSymbolicLink(), false, '无 legacy 时是真实目录')
    store.createPack({ memoryPackId: 'p1', scope: 'global', keywords: [] })
    assert.equal(existsSync(join(hubDir, 'p1', 'pack.json')), true)
  } finally {
    cleanup()
  }
})

test('C2：hubDir 已存在 → 不迁移（常规路径不受影响）', () => {
  const { root, cleanup } = tempRoot()
  try {
    const legacy = join(root, 'memory')
    mkdirSync(legacy, { recursive: true })
    const hubDir = join(root, 'memory-hub')
    mkdirSync(hubDir, { recursive: true })
    writeFileSync(join(hubDir, 'marker'), 'new')
    const store = new MemoryStore(hubDir)
    assert.equal(lstatSync(hubDir).isSymbolicLink(), false, '已存在目录保持真实目录')
    assert.equal(existsSync(join(hubDir, 'marker')), true)
    assert.equal(existsSync(join(legacy, 'marker')), false, 'legacy 未被污染')
  } finally {
    cleanup()
  }
})

test('C2：非缺省名 hubDir（自定义路径）→ 不触发 legacy 迁移', () => {
  const { root, cleanup } = tempRoot()
  try {
    const legacy = join(root, 'memory')
    mkdirSync(legacy, { recursive: true })
    const custom = join(root, 'my-custom-hub')
    const store = new MemoryStore(custom)
    assert.equal(lstatSync(custom).isSymbolicLink(), false, '自定义 hub 名不迁移 legacy')
    assert.equal(existsSync(custom), true)
    assert.equal(existsSync(legacy), true)
    assert.equal(store.hasPack('x'), false)
  } finally {
    cleanup()
  }
})

test('C2：hubDir 被同名文件占用（异常态）→ 不迁移不覆盖，hub 以只读语义可用', () => {
  const { root, cleanup } = tempRoot()
  try {
    const legacy = join(root, 'memory')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'memories.jsonl'), 'x\n')
    const hubDir = join(root, 'memory-hub')
    writeFileSync(hubDir, 'occupied') // 异常占位（文件而非目录）
    const store = new MemoryStore(hubDir)
    assert.equal(store.hasPack('x'), false, 'hub 不抛错（只读查询安全）')
    assert.equal(readFileSync(hubDir, 'utf8'), 'occupied', '占用文件未被覆盖')
    assert.equal(existsSync(join(legacy, 'memories.jsonl')), true, 'legacy 数据未受影响')
  } finally {
    cleanup()
  }
})
