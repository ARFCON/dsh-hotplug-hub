// test/selfcheck-ui.test.mjs — 自检视图（renderCheck）三态/新行/防抖的 UI 契约测试
//
// 对应审计修复：
//   U1 patchOk 三态消费：null（未知）渲染「警告」蓝点，不再与 false 一同误报「异常」
//   U2 stateOk 行：state.json 损坏在自检页显式可见（附修复指引文案）
//   U3 「激活包」行状态点与 conflicts 解耦；冲突状态由专属行承载
//   U4 doCheck busy 防抖：挂起期间重复触发不再并发多个 check RPC
// 复用 client-ui.test.mjs 的 mini-React 桩装配方式（真实组件逻辑 + 事件驱动 vdom）。
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const clientSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js'), 'utf8')

/* ---------------- mini-React 桩（与 client-ui.test.mjs 同一实现口径） ---------------- */
function createMiniReact() {
  const hooks = []
  let hookIndex = 0
  let renderFn = null
  let props = null
  let mounted = false
  const effects = []
  const createElement = (type, pnl, ...children) => ({
    type,
    props: { ...(pnl || {}), children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== true) },
  })
  const useState = (initial) => {
    const i = hookIndex++
    if (!(i in hooks)) hooks[i] = typeof initial === 'function' ? initial() : initial
    return [hooks[i], (v) => {
      hooks[i] = typeof v === 'function' ? v(hooks[i]) : v
      if (renderFn) { hookIndex = 0; renderFn.current = renderFn.comp(props) }
    }]
  }
  const useEffect = (fn) => { hookIndex++; if (!mounted) effects.push(fn) }
  const useRef = (initial) => { const i = hookIndex++; if (!(i in hooks)) hooks[i] = { current: initial }; return hooks[i] }
  const mount = (comp, p) => {
    props = p
    renderFn = { comp, current: null }
    hookIndex = 0
    renderFn.current = comp(p)
    mounted = true
    for (const fn of effects.splice(0)) fn()
    return renderFn
  }
  return { createElement, useState, useEffect, useRef, mount }
}

function walk(vdom, out = []) {
  if (Array.isArray(vdom)) { for (const v of vdom) walk(v, out); return out }
  if (vdom && typeof vdom === 'object' && typeof vdom.type === 'string') {
    out.push(vdom)
    walk(vdom.props.children, out)
  } else if (vdom && typeof vdom === 'object' && typeof vdom.type === 'function') {
    walk(vdom.type(vdom.props), out)
  }
  return out
}
const textOf = (vdom) => {
  let text = ''
  const visit = (node) => {
    if (node == null || node === false || node === true) return
    if (typeof node === 'string' || typeof node === 'number') { text += String(node); return }
    if (Array.isArray(node)) { node.forEach(visit); return }
    if (node.type === 'function') { visit(node.type(node.props)); return }
    visit(node.props.children)
  }
  visit(vdom)
  return text
}

function loadClient(remoteFace) {
  const react = createMiniReact()
  const savedWindow = globalThis.window
  const savedFetch = globalThis.fetch
  const storage = new Map()
  const windowStub = {
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    confirm: () => true,
    fetch: undefined,
  }
  globalThis.window = windowStub
  const registered = []
  const ctx = {
    effect: () => {},
    locale: { register: () => {}, bind: () => (key) => key },
    remote: { $mount: () => Promise.resolve(() => {}) },
    get: () => remoteFace,
    slots: { inject: (slot, factory) => registered.push(factory()), register: (def, comp) => ({ def, comp }) },
  }
  windowStub.__ModuleLoader__ = { load: (mod) => { windowStub.__exports = mod.factory(require) } }
  const require = (name) => (name === 'react' ? react : (() => { throw new Error('unexpected require ' + name) })())
  // eslint-disable-next-line no-eval
  eval(clientSrc)
  windowStub.__exports.apply(ctx)
  const { def, comp } = registered[0]
  const api = def.inject()
  const tree = react.mount(comp, { inject: api, locale: undefined })
  const restore = () => { globalThis.window = savedWindow; globalThis.fetch = savedFetch }
  return { api, tree, react, walk, textOf, restore }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

const baseCheck = (overrides = {}) => ({
  ok: true, version: '1.0.2', nodeVersion: 'v22.0.0', pnpmVersion: '9.0.0',
  profile: { name: 'web', dir: '/p' }, stateOk: true, manifestOk: true, patchOk: true,
  conflicts: [], activePack: 'pack.a', packCount: 1, storeCount: 0, memoryDir: '/m',
  memory: { dir: '/m', packs: [], activeEntries: 0 },
  ...overrides,
})

const remoteWith = (checkValue) => ({
  status: async () => ({ ok: true, value: { ok: true, version: '1.0.0', profile: { name: 'web' }, packs: [], store: { dir: '/store', entries: [] }, memoryDir: '/mem' } }),
  check: async () => ({ ok: true, value: checkValue }),
  marketList: async () => ({ ok: false, message: 'not stubbed' }),
  marketDetail: async () => ({ ok: false, message: 'not stubbed' }),
})

/** 打开自检页签并等待自动 doCheck 完成。 */
const openCheck = async (checkValue) => {
  const handle = loadClient(remoteWith(checkValue))
  const checkTab = handle.walk(handle.tree.current).find((n) => n.type === 'button' && textOf(n).includes('自检更新'))
  checkTab.props.onClick()
  await flush(); await flush()
  return handle
}

/** 抽取自检行：{dot, label, val} 列表。 */
const checkRows = (handle) => handle.walk(handle.tree.current)
  .filter((n) => n.props.className === 'hp_check' && Array.isArray(n.props.children) && n.props.children.length >= 3)
  .map((n) => ({
    dot: n.props.children[0].props['data-kind'],
    label: textOf(n.props.children[1]),
    val: textOf(n.props.children[2]),
  }))
const rowBy = (handle, label) => checkRows(handle).find((r) => r.label.includes(label))

let handle = null
afterEach(() => { if (handle) { handle.restore(); handle = null } })

describe('U1：patchOk 三态消费（null=未知 不再误报异常）', () => {
  it('patchOk=null（state 损坏/patch 不可读）→ 警告 + 蓝点，不是「异常」红点', async () => {
    handle = await openCheck(baseCheck({ patchOk: null, stateOk: false }))
    const row = rowBy(handle, 'Patch 状态')
    expect(row.val).toBe('警告')
    expect(row.dot).toBe('download')
  })

  it('patchOk=false（块真缺失）→ 异常红点（回归锚点）', async () => {
    handle = await openCheck(baseCheck({ patchOk: false }))
    const row = rowBy(handle, 'Patch 状态')
    expect(row.val).toBe('异常')
    expect(row.dot).toBe('error')
  })

  it('patchOk=true → 正常绿点（回归锚点）', async () => {
    handle = await openCheck(baseCheck())
    const row = rowBy(handle, 'Patch 状态')
    expect(row.val).toBe('正常')
    expect(row.dot).toBe('reused')
  })
})

describe('U2：stateOk 行（state.json 损坏显式可见）', () => {
  it('stateOk=false → 「状态文件」行异常 + 修复指引文案', async () => {
    handle = await openCheck(baseCheck({ stateOk: false, patchOk: null, activePack: null }))
    const row = rowBy(handle, '状态文件')
    expect(row.val).toBe('异常')
    expect(row.dot).toBe('error')
    expect(handle.textOf(handle.tree.current)).toContain('state.json 损坏')
  })

  it('stateOk=true → 正常（回归锚点）', async () => {
    handle = await openCheck(baseCheck())
    const row = rowBy(handle, '状态文件')
    expect(row.val).toBe('正常')
    expect(row.dot).toBe('reused')
  })
})

describe('U3：激活包行与冲突解耦 + 冲突专属行', () => {
  it('有冲突但激活包正常 → 「激活包」行绿点；「冲突矩阵」行红点且计数正确', async () => {
    handle = await openCheck(baseCheck({
      activePack: 'pack.a',
      conflicts: [{ packId: 'pack.b', reason: 'pkg-x 版本冲突 1.0.0 vs 2.0.0', suggest: '停用其中一个包' }],
    }))
    const active = rowBy(handle, '激活包')
    expect(active.val).toBe('pack.a')
    expect(active.dot).toBe('reused') // 不再被无关冲突染红
    const conflicts = rowBy(handle, '冲突矩阵')
    expect(conflicts.dot).toBe('error')
    expect(conflicts.val).toBe('1')
    expect(handle.textOf(handle.tree.current)).toContain('版本冲突')
  })

  it('无冲突 → 「冲突矩阵」行绿点 0 + 「无冲突」卡（回归锚点）', async () => {
    handle = await openCheck(baseCheck())
    expect(rowBy(handle, '冲突矩阵').dot).toBe('reused')
    expect(handle.textOf(handle.tree.current)).toContain('无冲突')
  })

  it('旧网关无 conflicts 字段（容错）→ 不抛、按 0 处理', async () => {
    const value = baseCheck()
    delete value.conflicts
    handle = await openCheck(value)
    expect(rowBy(handle, '冲突矩阵').val).toBe('0')
  })
})

describe('U4：doCheck busy 防抖（不并发多个 check RPC）', () => {
  it('挂起期间重复触发（页签自动 + 重新自检按钮）只发一次 RPC', async () => {
    let resolveCheck = null
    let calls = 0
    const deferred = new Promise((r) => { resolveCheck = r })
    const remote = {
      status: async () => ({ ok: true, value: { ok: true, version: '1.0.0', profile: { name: 'web' }, packs: [], store: { dir: '/s', entries: [] }, memoryDir: '/m' } }),
      check: async () => { calls += 1; return deferred },
      marketList: async () => ({ ok: false }),
      marketDetail: async () => ({ ok: false }),
    }
    handle = loadClient(remote)
    const checkTab = handle.walk(handle.tree.current).find((n) => n.type === 'button' && textOf(n).includes('自检更新'))
    checkTab.props.onClick() // 自动 doCheck（第一次）
    const recheck = handle.walk(handle.tree.current).find((n) => n.type === 'button' && textOf(n).includes('重新自检'))
    recheck.props.onClick() // 挂起期间再点（第二次，应被 busy 挡下）
    recheck.props.onClick() // 第三次
    await flush()
    expect(calls).toBe(1)
    resolveCheck({ ok: true, value: baseCheck() })
    await flush(); await flush()
    expect(rowBy(handle, '状态文件').val).toBe('正常')
  })
})
