// test/hotpack.test.mjs — parseHotpack 适配层 + dshpackToHotpack
import { describe, it, expect } from 'vitest'
import { parseHotpack, dshpackToHotpack } from '../lib/core/hotpack.js'

function validInput() {
  return {
    hotpack: '1.0',
    id: 'pack.x',
    name: 'X Pack',
    version: '1.0.0',
    description: 'd'.repeat(500),
    tags: ['t1', 't2'],
    plugins: [
      { id: 'p', name: 'pkg', source: { type: 'npm' }, version: '1.0.0' },
      { id: 'g', name: 'pkg-g', source: { type: 'github', repo: 'o/r', ref: 'main' } },
    ],
  }
}

describe('parseHotpack（vendor-shared 适配层，R-v5-11）', () => {
  it('合法输入：展示约束（desc≤300、tags 12×24）+ memory:{keep:true}', () => {
    const r = parseHotpack(validInput())
    expect(r.ok).toBe(true)
    expect(r.pack.description.length).toBe(300)
    expect(r.pack.memory).toEqual({ keep: true })
    expect(r.pack.id).toBe('pack.x')
    expect(r.pack.plugins).toHaveLength(2)
  })

  it('JSON 字符串输入', () => {
    expect(parseHotpack(JSON.stringify(validInput())).ok).toBe(true)
  })

  it('统一语义：「1.02.3」/ 保留名 con 拒绝（曾 hotplug 单正则放行）', () => {
    const bad1 = parseHotpack({ ...validInput(), version: '1.02.3' })
    expect(bad1.ok).toBe(false)
    const bad2 = parseHotpack({
      ...validInput(),
      plugins: [{ id: 'p', name: 'con', source: { type: 'npm' }, version: '1.0.0' }],
    })
    expect(bad2.ok).toBe(false)
  })

  it('legacy 形态拒绝（allowLegacy:false，hotplug 只收 hotpack 1.0 显式形态）', () => {
    const r = parseHotpack({ packId: 'x', name: 'n', version: '1.0.0', bundles: [] })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('hotpack')
  })

  it('错误形态：{ok:false, error:string}（RPC 层再归一化）', () => {
    const r = parseHotpack('{bad')
    expect(r.ok).toBe(false)
    expect(typeof r.error).toBe('string')
  })

  it('H-10：ref 允许合法 /（经 shared 单源）', () => {
    const r = parseHotpack({
      ...validInput(),
      plugins: [{ id: 'g', name: 'pkg-g', source: { type: 'github', repo: 'o/r', ref: 'feature/x' }, config: {} }],
    })
    expect(r.ok).toBe(true)
    expect(r.pack.plugins[0].source.ref).toBe('feature/x')
  })
})

describe('dshpackToHotpack', () => {
  it('合法 dshpack → hotpack（H-11b：显式 bundle.id 优先于 role 派生）', () => {
    const r = dshpackToHotpack(JSON.stringify({
      packId: 'cn.pack', name: 'N', version: '1.0.0',
      bundles: [{ id: 'b1', package: 'pkg-a', version: '1.0.0', role: 'tool' }],
    }))
    expect(r.ok).toBe(true)
    expect(r.pack.id).toBe('cn.pack')
    expect(r.pack.plugins[0].id).toBe('b1')
  })

  it('非法 JSON / 非对象 → 报错', () => {
    expect(dshpackToHotpack('{').ok).toBe(false)
    expect(dshpackToHotpack('[1]').ok).toBe(false)
  })

  it('H-11b 收紧（收敛到 vendor-shared 单一桥接）：npm 缺精确 version 报错、空 bundles 报错、github 缺 repo 报错', () => {
    // npm 缺 version（旧分叉曾静默跳过）
    const r1 = dshpackToHotpack(JSON.stringify({
      packId: 'x', name: 'N', version: '1.0.0',
      bundles: [{ id: 'a', package: 'pkg-a' }],
    }))
    expect(r1.ok).toBe(false)
    expect(r1.error).toContain('version')
    // 空 bundles（旧分叉曾产出空 pack）
    const r2 = dshpackToHotpack(JSON.stringify({ packId: 'x', name: 'N', version: '1.0.0', bundles: [] }))
    expect(r2.ok).toBe(false)
    // github 源缺 repo
    const r3 = dshpackToHotpack(JSON.stringify({
      packId: 'x', name: 'N', version: '1.0.0',
      bundles: [{ id: 'a', package: 'pkg-a', version: '1.0.0', source: 'github' }],
    }))
    expect(r3.ok).toBe(false)
  })
})
