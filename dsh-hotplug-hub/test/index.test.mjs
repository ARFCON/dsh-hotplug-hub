// test/index.test.mjs — 入口导出面（与重构前一致）
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as entry from '../lib/index.js'
import { HotplugGateway } from '../lib/gateway.js'
import { applyIsolatedEnv, isolatedDsh } from './helpers.mjs'

let restoreEnv = null
let iso = null

beforeEach(() => {
  iso = isolatedDsh()
  restoreEnv = applyIsolatedEnv(iso.dshHome)
})
afterEach(() => { if (restoreEnv) restoreEnv(); if (iso) iso.cleanup() })

describe('lib/index.js 入口', () => {
  it('导出面与重构前一致', () => {
    expect(entry.name).toBe('dsh-hotplug-hub')
    expect(entry.inject).toEqual([])
    expect(typeof entry.apply).toBe('function')
    expect(entry.default).toBe(HotplugGateway)
    expect(entry.HotplugGateway).toBe(HotplugGateway)
    expect(typeof entry.parseHotpack).toBe('function')
    expect(typeof entry.marketListAsync).toBe('function')
    expect(typeof entry.extractIntro).toBe('function')
    expect(typeof entry.extractInstall).toBe('function')
  })

  it('apply(ctx) 挂载网关（空插座零副作用）', () => {
    // Cordis 风格 ctx：reflect.provide 为 no-op
    expect(() => entry.apply({ reflect: { provide: () => {} } })).not.toThrow()
  })

  it('parseHotpack 经入口可用', () => {
    const r = entry.parseHotpack(JSON.stringify({
      hotpack: '1.0', id: 'x', name: 'X', version: '1.0.0',
      plugins: [{ id: 'p', name: 'pkg', source: { type: 'npm' }, version: '1.0.0' }],
    }))
    expect(r.ok).toBe(true)
  })
})
