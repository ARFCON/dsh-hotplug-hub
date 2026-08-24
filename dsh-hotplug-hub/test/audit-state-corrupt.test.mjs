// test/audit-state-corrupt.test.mjs — state.json 损坏语义（读路径审计）
//
// 背景：readJson 把一切错误吞成 null——state.json 损坏（半截写/手改坏 JSON）被当成
// 「全新状态 {activePack:null}」，下一次 writeState 直接覆盖：activePack /
// activeInstall 永久孤儿化（patch 块、link: 依赖、npm 包全部泄漏且无人认领）。
// 契约：缺失 → 默认状态；存在但损坏 → 标记 corrupted，status 显式 stateOk:false，
// 变更类操作（import/activate/deactivate/remove）拒绝执行（宁可拒绝也不静默覆盖）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { HotplugGateway } from '../lib/gateway.js'
import { statusSync } from '../lib/core/status.js'
import { readState } from '../lib/core/state.js'
import { statePath } from '../lib/core/paths.js'
import { applyIsolatedEnv, isolatedDsh, samplePack } from './helpers.mjs'

let restoreEnv = null
let iso = null
let gateway = null

beforeEach(() => {
  iso = isolatedDsh()
  restoreEnv = applyIsolatedEnv(iso.dshHome)
  gateway = new HotplugGateway({ reflect: { provide: () => {} } })
})
afterEach(() => {
  if (restoreEnv) restoreEnv()
  if (iso) iso.cleanup()
})

function writeStateRaw(text) {
  mkdirSync(join(iso.dshHome, 'hotplug-hub'), { recursive: true })
  writeFileSync(statePath(), text)
}

describe('state.json 损坏语义', () => {
  it('缺失 → 默认状态，stateOk:true（既有行为回归）', () => {
    const s = readState()
    expect(s.activePack).toBeNull()
    expect(statusSync().stateOk).toBe(true)
  })

  it('半截 JSON → corrupted：readState 标记、statusSync stateOk:false', () => {
    writeStateRaw('{ "activePack": "pack.a", "hist')
    const s = readState()
    expect(s.corrupted).toBe(true)
    expect(statusSync().stateOk).toBe(false)
    // status 本身不崩溃（activePack 读数为 null——不信任损坏数据）
    expect(statusSync().activePack).toBeNull()
  })

  it('合法 JSON 但形状错误（数组）→ corrupted', () => {
    writeStateRaw('[1,2,3]')
    expect(readState().corrupted).toBe(true)
    expect(statusSync().stateOk).toBe(false)
  })

  it('合法 JSON 且为对象 → 正常读取（非 corrupted）', () => {
    writeStateRaw(JSON.stringify({ version: 1, activePack: 'pack.a', history: [] }))
    const s = readState()
    expect(s.corrupted).toBeUndefined()
    expect(s.activePack).toBe('pack.a')
    expect(statusSync().stateOk).toBe(true)
  })

  it('corrupted 状态下 activate 拒绝（不静默覆盖孤儿化 activeInstall）', async () => {
    // 先在健康状态下导入（导入产物不依赖 state）；再损坏 state
    await gateway.importPack(JSON.stringify(samplePack({ id: 'pack.a' })))
    writeStateRaw('{ broken')
    const r = await gateway.activate('pack.a')
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/state\.json|损坏/)
    // 磁盘状态未被覆盖（仍是损坏原文）
    const { readFileSync } = await import('node:fs')
    expect(readFileSync(statePath(), 'utf8')).toBe('{ broken')
  })

  it('corrupted 状态下 deactivate / removePack 拒绝', async () => {
    writeStateRaw('{ broken')
    const d = await gateway.deactivate()
    expect(d.ok).toBe(false)
    expect(d.message).toMatch(/state\.json|损坏/)
    await gateway.importPack(JSON.stringify(samplePack({ id: 'pack.b' })))
    const rm = await gateway.removePack('pack.b')
    expect(rm.ok).toBe(false)
    expect(rm.message).toMatch(/state\.json|损坏/)
  })

  it('corrupted 状态下 importPack 拒绝（覆盖激活中包的风险）', async () => {
    writeStateRaw('{ broken')
    const r = await gateway.importPack(JSON.stringify(samplePack({ id: 'pack.c' })))
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/state\.json|损坏/)
  })

  it('corrupted 状态修复（删除坏文件）后恢复正常操作', async () => {
    writeStateRaw('{ broken')
    const { rmSync } = await import('node:fs')
    rmSync(statePath())
    const imp = await gateway.importPack(JSON.stringify(samplePack({ id: 'pack.d' })))
    expect(imp.ok).toBe(true)
    expect(statusSync().stateOk).toBe(true)
  })
})
