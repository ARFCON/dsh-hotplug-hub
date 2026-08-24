// test/regression-marker-exact.test.mjs — patch 块 marker 精确匹配（前缀 id 不得误判）
// BUG 复现：appendPatchBlock 曾用 `text.includes(marker(id))` 做「已存在同名块」判定，
// 与 shared findPatchBlock 的精确匹配契约不一致——当 patch 已含 `## hotplug:pack.a.b`
// 时挂载 `pack.a`（前缀 id）被误判为「已存在」而拒绝。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendPatchBlock, removePatchBlock } from '../lib/core/patch.js'
import { applyIsolatedEnv, isolatedDsh, samplePack } from './helpers.mjs'

let restoreEnv = null
let iso = null

beforeEach(() => {
  iso = isolatedDsh()
  restoreEnv = applyIsolatedEnv(iso.dshHome)
})
afterEach(() => { if (restoreEnv) restoreEnv(); if (iso) iso.cleanup() })

describe('patch 块 marker 精确匹配（前缀 id 契约）', () => {
  it('存在前缀 id 块（pack.a.b）时，挂载 pack.a 不应被误拒', () => {
    writeFileSync(
      join(iso.profile, 'cordis.patch.yml'),
      '## hotplug:pack.a.b\n- insert:\n    - id: hp-pack.a.b-x\n      name: \'x\'\n      config: {}\n'
    )
    const r = appendPatchBlock(samplePack({ id: 'pack.a' }))
    expect(r.ok).toBe(true)
    const text = readFileSync(join(iso.profile, 'cordis.patch.yml'), 'utf8')
    // 两块并存，各自独立（不互相吞并）
    expect(text).toContain('## hotplug:pack.a.b\n')
    expect(text).toContain('## hotplug:pack.a\n')
  })

  it('移除 pack.a 不得连带移除 pack.a.b（精确匹配，非前缀）', () => {
    writeFileSync(
      join(iso.profile, 'cordis.patch.yml'),
      '## hotplug:pack.a.b\n- insert:\n    - id: hp-pack.a.b-x\n      name: \'x\'\n      config: {}\n' +
      '## hotplug:pack.a\n- insert:\n    - id: hp-pack.a-y\n      name: \'y\'\n      config: {}\n'
    )
    expect(removePatchBlock('pack.a')).toEqual({ ok: true, removed: true })
    const text = readFileSync(join(iso.profile, 'cordis.patch.yml'), 'utf8')
    expect(text).toContain('## hotplug:pack.a.b')
    expect(text).not.toContain('## hotplug:pack.a\n')
  })
})
