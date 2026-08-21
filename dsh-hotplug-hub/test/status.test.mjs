// test/status.test.mjs — statusSync / previewPack / checkAsync（假 pnpm 走真实 spawn）
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { copyFileSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { statusSync, importPackSync, previewPack, checkAsync } from '../lib/core/status.js'
import { applyIsolatedEnv, isolatedDsh, samplePack } from './helpers.mjs'

let restoreEnv = null
let iso = null

beforeEach(() => {
  iso = isolatedDsh()
  restoreEnv = applyIsolatedEnv(iso.dshHome)
})
afterEach(() => { if (restoreEnv) restoreEnv(); if (iso) iso.cleanup() })

/** 在隔离 PATH 放置假 pnpm：pnpm.exe = node.exe 副本（spawn 免 shell 可解析）。
 * 说明：Windows 下 spawn 无法直接启动 .cmd（EINVAL/ENOENT），DSH 运行时内置
 * pnpm.exe 独立可执行文件——测试用 node 副本模拟该形态。
 * POSIX：sh 包装必须可执行位（writeFileSync 默认 0644 → spawn EACCES，CI 红根因）。 */
function fakePnpm() {
  const exe = process.platform === 'win32' ? join(iso.dshHome, 'pnpm.exe') : join(iso.dshHome, 'pnpm')
  if (process.platform === 'win32') {
    copyFileSync(process.execPath, exe)
  } else {
    // POSIX：sh 包装（node 不可复制为可执行脚本名，用 sh 脚本 exec node）
    writeFileSync(exe, `#!/bin/sh\nnode -e "console.log('v9.99.9')"\n`)
    chmodSync(exe, 0o755)
  }
}

describe('statusSync', () => {
  it('空状态：无包、无激活、store 空', () => {
    const s = statusSync()
    expect(s.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(s.activePack).toBeNull()
    expect(s.packs).toEqual([])
    expect(s.store.entries).toEqual([])
    expect(s.profile.name).toBe('web')
  })

  it('导入后：packs 列表 + 插件 cached 判定 + activePatchOk', () => {
    importPackSync(JSON.stringify(samplePack()))
    const s = statusSync()
    expect(s.packs).toHaveLength(1)
    expect(s.packs[0].id).toBe('pack.test')
    expect(s.packs[0].active).toBe(false)
    expect(s.activePatchOk).toBe(true) // 无激活包 → true
    // 插件路径信息
    const plugins = s.packs[0].plugins
    expect(plugins).toHaveLength(2)
    expect(plugins[0].cached).toBe(false) // npm 未装
    expect(plugins[1].cached).toBe(false) // path 不存在
  })
})

describe('previewPack', () => {
  it('npm 缺失 → download；path 存在 → reused；github 缺失 → download', async () => {
    const src = join(iso.dshHome, 'src', 'pkg-b')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'pkg-b', version: '1.0.0' }))
    const pack = samplePack({ plugins: [
      { id: 'a', name: 'pkg-a', source: { type: 'npm' }, version: '1.0.0' },
      { id: 'b', name: 'pkg-b', source: { type: 'path', path: src } },
      { id: 'g', name: 'pkg-g', source: { type: 'github', repo: 'o/r', ref: 'main' } },
    ] })
    importPackSync(JSON.stringify(pack))
    const r = await previewPack('pack.test')
    expect(r.ok).toBe(true)
    expect(r.refs.map((x) => x.action)).toEqual(['download', 'reused', 'download'])
    expect(r.wouldReplace).toBeNull()
  })

  it('未找到包 → 明确错误', async () => {
    const r = await previewPack('nope')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('未找到包')
  })
})

describe('checkAsync（假 pnpm 真实 spawn）', () => {
  it('自检：pnpm 版本 / manifest / patch / 冲突', async () => {
    fakePnpm()
    importPackSync(JSON.stringify(samplePack()))
    // npm 插件装进 profile（path 源留缺失 → cached false 不构成冲突）
    const r = await checkAsync()
    expect(r.ok).toBeUndefined()
    // 假 pnpm（node 副本）→ --version 输出 node 版本（v 前缀），验证 spawn 成功路径
    expect(r.pnpmVersion).toMatch(/^v\d+\.\d+\.\d+/)
    expect(r.nodeVersion).toMatch(/^v/)
    expect(r.manifestOk).toBe(true)
    expect(r.patchOk).toBe(true)
    expect(r.conflicts).toEqual([])
    expect(r.memoryDir.endsWith('memory-hub')).toBe(true)
  })

  it('pnpm 缺失不崩溃（pnpmVersion=null）', async () => {
    const r = await checkAsync()
    expect(r.pnpmVersion).toBeNull()
    expect(r.manifestOk).toBe(true)
  })

  it('同名不同版本 → 冲突矩阵', async () => {
    const pack1 = samplePack({ id: 'pack.one', plugins: [{ id: 'a', name: 'pkg-x', source: { type: 'npm' }, version: '1.0.0' }] })
    const pack2 = samplePack({ id: 'pack.two', plugins: [{ id: 'a', name: 'pkg-x', source: { type: 'npm' }, version: '2.0.0' }] })
    importPackSync(JSON.stringify(pack1))
    importPackSync(JSON.stringify(pack2))
    const r = await checkAsync()
    expect(r.conflicts).toHaveLength(1)
    expect(r.conflicts[0].reason).toContain('版本冲突')
  })
})
