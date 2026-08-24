// test/gateway-matrix.test.mjs — 网关生命周期矩阵（导入 × 激活 × 停用 × 删除 × 状态损坏 × 历史环 × 串行链）
//
// 与 gateway-instance.test.mjs（实例接线冒烟）互补：此处按「操作 × 前置状态」枚举钉死：
//   - importPack：激活中拒覆盖 / 未激活可重导入（磁盘 manifest 替换）/ state.json 损坏拒写；
//   - activate：不存在 / 磁盘清单无效（清单校验失败）/ 已激活（already 且无需重启）；
//   - history：真实交替激活 5 轮 +10 事件；直接 writeState 预置 70 条后截断为 64（环形上限）；
//   - normalizeRpc 成功信封（code OK / exitCode 0）与 serialize 异常隔离（坏任务不断链）；
//   - removePack：移除后 statusSync 不再列出、packs 目录消失；deactivate 空激活拒绝。
// 全程 path 源包（零 spawn），隔离 DSH 根，不触真实网络与 ~/.dsh。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { HotplugGateway } from '../lib/gateway.js'
import { statusSync } from '../lib/core/status.js'
import { readState, writeState } from '../lib/core/state.js'
import { packsDir, statePath } from '../lib/core/paths.js'
import { applyIsolatedEnv, isolatedDsh } from './helpers.mjs'

let restoreEnv = null
let iso = null
let gateway = null

beforeEach(() => {
  iso = isolatedDsh()
  restoreEnv = applyIsolatedEnv(iso.dshHome)
  // Cordis 风格 ctx：reflect.provide 为 no-op（Service 基类注册服务用）
  gateway = new HotplugGateway({ reflect: { provide: () => {} } })
})
afterEach(() => { if (restoreEnv) restoreEnv(); if (iso) iso.cleanup() })

/** path 源包（零 spawn 生命周期用；两包交替时各自独立源目录，插件名一致不冲突——非同时激活）。 */
function pathPack(id = 'pack.p', name = 'P') {
  const src = join(iso.dshHome, 'src', id)
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'pkg-p', version: '1.0.0' }))
  return {
    hotpack: '1.0', id, name, version: '1.0.0',
    plugins: [{ id: 'main', name: 'pkg-p', source: { type: 'path', path: src }, config: {} }],
  }
}

function writeStateRaw(text) {
  mkdirSync(join(iso.dshHome, 'hotplug-hub'), { recursive: true })
  writeFileSync(statePath(), text)
}

describe('importPack 矩阵', () => {
  it('激活中的包拒绝覆盖导入', async () => {
    await gateway.importPack(JSON.stringify(pathPack()))
    await gateway.activate('pack.p')
    const again = await gateway.importPack(JSON.stringify(pathPack()))
    expect(again.ok).toBe(false)
    expect(again.message).toContain('激活中')
  })

  it('未激活的包可重导入：磁盘 manifest 被替换', async () => {
    const imp = await gateway.importPack(JSON.stringify(pathPack()))
    expect(imp.ok).toBe(true)
    const v2 = pathPack()
    v2.version = '2.0.0'
    const again = await gateway.importPack(JSON.stringify(v2))
    expect(again.ok).toBe(true)
    const onDisk = JSON.parse(readFileSync(join(packsDir(), 'pack.p', 'hotpack.json'), 'utf8'))
    expect(onDisk.version).toBe('2.0.0')
  })

  it('state.json 损坏 → 拒绝导入（错误提及 state.json，不静默覆盖）', async () => {
    writeStateRaw('{ broken')
    const r = await gateway.importPack(JSON.stringify(pathPack()))
    expect(r.ok).toBe(false)
    expect(r.message).toContain('state.json')
    expect(readFileSync(statePath(), 'utf8')).toBe('{ broken') // 损坏原文未被覆盖
  })
})

describe('activate 矩阵', () => {
  it('不存在的包 → 失败（未找到包）', async () => {
    const r = await gateway.activate('nope')
    expect(r.ok).toBe(false)
    expect(r.message).toContain('未找到包')
  })

  it('磁盘清单无效（手写 plugins:[]）→ 清单校验失败', async () => {
    mkdirSync(join(packsDir(), 'pack.x'), { recursive: true })
    writeFileSync(join(packsDir(), 'pack.x', 'hotpack.json'), JSON.stringify({
      hotpack: '1.0', id: 'pack.x', name: 'X', version: '1.0.0', plugins: [],
    }))
    const r = await gateway.activate('pack.x')
    expect(r.ok).toBe(false)
    expect(r.message).toContain('清单校验失败')
  })

  it('已激活的包重复 activate → {ok:true, already:true, restartNeeded:false}', async () => {
    await gateway.importPack(JSON.stringify(pathPack()))
    await gateway.activate('pack.p')
    const again = await gateway.activate('pack.p')
    expect(again.ok).toBe(true)
    expect(again.already).toBe(true)
    expect(again.restartNeeded).toBe(false)
  })
})

describe('history 环形记录（上限 64）', () => {
  it('真实 activate/deactivate 两包交替 5 轮 → history +10、末事件 deactivate', async () => {
    await gateway.importPack(JSON.stringify(pathPack('pack.p', 'P')))
    await gateway.importPack(JSON.stringify(pathPack('pack.q', 'Q')))
    expect(readState().history).toHaveLength(0) // 导入不产生历史
    for (let i = 0; i < 5; i++) {
      const act = await gateway.activate(i % 2 === 0 ? 'pack.p' : 'pack.q')
      expect(act.ok).toBe(true)
      const deact = await gateway.deactivate()
      expect(deact.ok).toBe(true)
    }
    const history = readState().history
    expect(history).toHaveLength(10) // 每轮 activate + deactivate 各 1 条
    expect(history[history.length - 1].event).toBe('deactivate')
  })

  it('直接 writeState 预置 70 条历史 + 一次 deactivate → 截断为 64（slice(-64) 环形）', async () => {
    await gateway.importPack(JSON.stringify(pathPack()))
    await gateway.activate('pack.p')
    const events = Array.from({ length: 70 }, (_, i) => ({
      event: 'activate', packId: 'pack.p', at: new Date(Date.now() - (70 - i) * 1000).toISOString(),
    }))
    writeState({ version: 1, activePack: 'pack.p', activeInstall: { packId: 'pack.p', installedNpm: [] }, history: events })
    const deact = await gateway.deactivate()
    expect(deact.ok).toBe(true)
    expect(readState().history).toHaveLength(64)
    expect(readState().history[63].event).toBe('deactivate') // 最新事件保留在尾部
  })
})

describe('normalizeRpc / serialize', () => {
  it('status() 成功信封透传：code=OK、exitCode=0', () => {
    const s = gateway.status()
    expect(s.code).toBe('OK')
    expect(s.exitCode).toBe(0)
    expect(s.activePack).toBeNull()
  })

  it('serialize：任务异常不破坏链——下一个任务照常执行', async () => {
    await gateway.serialize(() => Promise.reject(new Error('boom'))).catch(() => {})
    const r = await gateway.serialize(() => 'ok')
    expect(r).toBe('ok')
  })
})

describe('removePack / deactivate 矩阵', () => {
  it('移除未激活的包：statusSync 不再列出、packs 目录消失', async () => {
    await gateway.importPack(JSON.stringify(pathPack()))
    const r = await gateway.removePack('pack.p')
    expect(r.ok).toBe(true)
    expect(statusSync().packs.map((p) => p.id)).not.toContain('pack.p')
    expect(existsSync(join(packsDir(), 'pack.p'))).toBe(false)
  })

  it('无激活包时 deactivate → 失败（没有激活）', async () => {
    const r = await gateway.deactivate()
    expect(r.ok).toBe(false)
    expect(r.message).toContain('没有激活')
  })
})
