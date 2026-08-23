// test/patch.test.mjs — patch 分节合并（R-v5-12）/ 四写者锁 / patch id 统一 / 挂载对称性（H-9）
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import {
  patchInstanceId, patchMarker, buildPatchBlock, appendPatchBlock, removePatchBlock,
  mountPack, unmountPack, patchLockPath,
} from '../lib/core/patch.js'
import { applyIsolatedEnv, isolatedDsh, samplePack } from './helpers.mjs'

let restoreEnv = null
let iso = null

beforeEach(() => {
  iso = isolatedDsh()
  restoreEnv = applyIsolatedEnv(iso.dshHome)
})
afterEach(() => { if (restoreEnv) restoreEnv(); if (iso) iso.cleanup() })

describe('patch 块构建（阶段 4 契约格式）', () => {
  it('patchInstanceId = vendor-shared patchIdFor（统一算法：清洗保留 . _ - + 64 上限 + 哈希后缀）', () => {
    expect(patchInstanceId('pack.a', 'plugin-1')).toBe('hp-pack.a-plugin-1')
    expect(patchInstanceId('pack.a', 'b')).toBe('hp-pack.a-b')
    expect(patchInstanceId('x'.repeat(40), 'y'.repeat(40)).length).toBeLessThanOrEqual(64)
    expect(patchMarker('pack.a')).toBe('## hotplug:pack.a')
  })

  it('buildPatchBlock：vendor-shared 序列化（yaml 回读自校验；marker 不在块内）', async () => {
    const block = buildPatchBlock(samplePack())
    expect(block.ok).toBe(true)
    expect(block.text.startsWith('- insert:\n')).toBe(true)
    expect(block.text).toContain('    - id: hp-pack.test-a')
    expect(block.text).toContain('name: pkg-a')
    expect(block.text).not.toContain('# hotplug:pack.test') // marker 不在块内
    // 产物可回读且语义等价（vendor-shared serializePatch 的强保证）
    const { parsePatchYaml } = await import('../vendor-shared/index.mjs')
    const back = parsePatchYaml(block.text)
    expect(back.ok).toBe(true)
    expect(back.doc[0].insert).toHaveLength(2)
  })
})

describe('appendPatchBlock / removePatchBlock（锁内分节合并）', () => {
  it('追加 → 幂等拒绝 → 移除；锁文件释放', () => {
    const pack = samplePack()
    const r1 = appendPatchBlock(pack)
    expect(r1.ok).toBe(true)
    const text = readFileSync(iso.profile + '/cordis.patch.yml', 'utf8')
    expect(text.startsWith('## hotplug:pack.test\n- insert:\n')).toBe(true)
    // 锁已释放
    expect(existsSync(patchLockPath())).toBe(false)
    // 重复追加拒绝（状态不一致保护）
    const r2 = appendPatchBlock(pack)
    expect(r2.ok).toBe(false)
    expect(r2.error).toContain('已存在')
    // 移除（契约形态）——返回统一 {ok, removed} 形状（审计修复：锁失败不再静默 false）
    expect(removePatchBlock('pack.test')).toEqual({ ok: true, removed: true })
    expect(readFileSync(iso.profile + '/cordis.patch.yml', 'utf8')).not.toContain('hotplug:pack.test')
    expect(removePatchBlock('pack.test')).toEqual({ ok: true, removed: false })
  })

  it('移除保留其它块与注释（分节语义）', () => {
    writeFileSync(join(iso.profile, 'cordis.patch.yml'), '# 顶部注释\n## desktop:keep\n- insert:\n    - id: keep\n      name: \'x\'\n      config: {}\n')
    appendPatchBlock(samplePack())
    removePatchBlock('pack.test')
    const text = readFileSync(join(iso.profile, 'cordis.patch.yml'), 'utf8')
    expect(text).toContain('# 顶部注释')
    expect(text).toContain('## desktop:keep')
    expect(text).toContain("name: 'x'")
    expect(text).not.toContain('pack.test')
  })

  it('旧内联形态（- insert:  # hotplug:pack.test）移除兼容（迁移规则 §9）', () => {
    writeFileSync(join(iso.profile, 'cordis.patch.yml'), '# 顶部注释\n- insert:  # hotplug:pack.test\n    - id: hp-old\n      name: \'old\'\n      config: {}\n')
    expect(removePatchBlock('pack.test')).toEqual({ ok: true, removed: true })
    const text = readFileSync(join(iso.profile, 'cordis.patch.yml'), 'utf8')
    expect(text).toContain('# 顶部注释')
    expect(text).not.toContain('hotplug:pack.test')
    expect(text).not.toContain('hp-old')
  })

  it('追加时识别旧内联形态为"已存在"（防双块）', () => {
    writeFileSync(join(iso.profile, 'cordis.patch.yml'), '- insert:  # hotplug:pack.test\n    - id: hp-old\n      name: \'old\'\n      config: {}\n')
    const r = appendPatchBlock(samplePack())
    expect(r.ok).toBe(false)
    expect(r.error).toContain('已存在')
  })
})

describe('mountPack / unmountPack 对称回滚（H-9，path 源，零 spawn）', () => {
  it('挂载（link + 分节 patch）→ 卸载（link 移除 + patch 移除）往返一致', async () => {
    // 构造真实 path 源插件目录
    const srcDir = join(iso.dshHome, 'plugin-src', 'pkg-b')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'package.json'), JSON.stringify({ name: 'pkg-b', version: '1.0.0' }))
    const pack = samplePack({ plugins: [{ id: 'b', name: 'pkg-b', source: { type: 'path', path: srcDir }, config: {} }] })

    const m = await mountPack(pack)
    expect(m.ok).toBe(true)
    const manifest = JSON.parse(readFileSync(join(iso.profile, 'package.json'), 'utf8'))
    expect(String(manifest.dependencies['pkg-b'])).toContain('link:')
    expect(readFileSync(join(iso.profile, 'cordis.patch.yml'), 'utf8')).toContain('hp-pack.test-b')

    const u = await unmountPack(pack)
    expect(u.ok).toBe(true)
    const after = JSON.parse(readFileSync(join(iso.profile, 'package.json'), 'utf8'))
    expect(after.dependencies['pkg-b']).toBeUndefined()
    expect(readFileSync(join(iso.profile, 'cordis.patch.yml'), 'utf8')).not.toContain('hotplug:pack.test')
  })

  it('挂载失败（path 源缺失）→ 显式错误 + steps 已记录', async () => {
    const okDir = join(iso.dshHome, 'plugin-src', 'pkg-ok')
    mkdirSync(okDir, { recursive: true })
    writeFileSync(join(okDir, 'package.json'), JSON.stringify({ name: 'pkg-ok', version: '1.0.0' }))
    const pack = samplePack({ plugins: [
      { id: 'ok', name: 'pkg-ok', source: { type: 'path', path: okDir }, config: {} },
      { id: 'bad', name: 'pkg-bad', source: { type: 'path', path: join(iso.dshHome, 'nope') }, config: {} },
    ] })
    const m = await mountPack(pack)
    expect(m.ok).toBe(false)
    expect(m.error).toContain('nope')
    expect(Array.isArray(m.steps)).toBe(true)
    expect(m.steps[0].status).toBe('reused')
  })

  it('挂载失败（appendPatchBlock 拒绝已存在块）→ 回滚已 link 的依赖（审计修复：无半挂载）', async () => {
    const okDir = join(iso.dshHome, 'plugin-src', 'pkg-ok')
    mkdirSync(okDir, { recursive: true })
    writeFileSync(join(okDir, 'package.json'), JSON.stringify({ name: 'pkg-ok', version: '1.0.0' }))
    const pack = samplePack({ plugins: [{ id: 'ok', name: 'pkg-ok', source: { type: 'path', path: okDir }, config: {} }] })
    // 预置同名 patch 块，使 appendPatchBlock 在 link 之后失败，验证回滚撤销 link: 依赖与 junction
    writeFileSync(join(iso.profile, 'cordis.patch.yml'), '## hotplug:pack.test\n- insert: []\n')
    const m = await mountPack(pack)
    expect(m.ok).toBe(false)
    // 审计修复断言：失败后 profile 无 link: 残留（此前仅撤 patch+bundles，link 残留）
    const manifest = JSON.parse(readFileSync(join(iso.profile, 'package.json'), 'utf8'))
    expect(manifest.dependencies?.['pkg-ok']).toBeUndefined()
    expect(existsSync(join(iso.profile, 'node_modules', 'pkg-ok'))).toBe(false)
  })
})
