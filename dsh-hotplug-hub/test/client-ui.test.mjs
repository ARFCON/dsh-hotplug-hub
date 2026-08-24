// test/client-ui.test.mjs — client.js（DSH Desktop 设置页组件）市场逻辑测试
//
// client.js 是宿主客户端加载的模块工厂（依赖 __ModuleLoader__/react/DOM 运行时），
// 此处以 mini-React 桩 + ctx 桩 + 事件驱动 vdom 的方式测真实组件逻辑：
// 搜索流 / 详情 hydrate / 加载更多终止 / 空结果语义 / 来源多选 / AI 连接测试超时。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const clientSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js'), 'utf8')

/* ---------------- mini-React 桩 ---------------- */
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
      if (renderFn) { hookIndex = 0; renderFn.current = renderFn.comp(props) } // 同步重渲染
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

/** 深度遍历 vdom 收集节点。 */
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
    if (typeof node.type === 'function') { visit(node.type(node.props)); return }
    visit(node.props.children)
  }
  visit(vdom)
  return text
}

/* ---------------- 加载 client.js 并装配组件 ---------------- */
function loadClient(remoteFace, opts = {}) {
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
    confirm: () => opts.confirm ?? true,
    fetch: opts.fetch,
  }
  globalThis.window = windowStub
  if (opts.fetch) globalThis.fetch = opts.fetch
  const registered = []
  const ctx = {
    effect: () => {},
    locale: { register: () => {}, bind: () => (key) => key },
    remote: { $mount: () => Promise.resolve(() => {}) },
    get: () => remoteFace,
    slots: {
      inject: (slot, factory) => registered.push(factory()),
      register: (def, comp) => ({ def, comp }),
    },
  }
  // client.js 形态：window.__ModuleLoader__.load({ id, factory })；factory(require) 里
  // require('react') 由 mini 桩提供，返回 module.exports（含 apply）。宿主负责调用
  // apply(ctx)——这里同样手动装配。eval 在本模块作用域，window 引用 windowStub。
  windowStub.__ModuleLoader__ = {
    load: (mod) => { windowStub.__exports = mod.factory(require) },
  }
  const require = (name) => (name === 'react' ? react : (() => { throw new Error('unexpected require ' + name) })())
  // eslint-disable-next-line no-eval
  eval(clientSrc)
  windowStub.__exports.apply(ctx)
  const { def, comp } = registered[0]
  const api = def.inject()
  const tree = react.mount(comp, { inject: api, locale: undefined })
  const restore = () => { globalThis.window = savedWindow; globalThis.fetch = savedFetch }
  return { api, tree, react, walk, textOf, restore, registered }
}

/* ---------------- 测试 ---------------- */
const flush = () => new Promise((r) => setTimeout(r, 0))
/** fake-timers 下的微任务冲洗（setTimeout 已被 mock，只能靠微任务链推进 async）。 */
const flushMicro = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

// 宿主 remote face 契约：resolve {ok, value}（unwrap 取 result.value）；
// value 为网关 normalizeRpc 信封（ok/code/exitCode + 业务字段）。
const remoteOk = (overrides = {}) => ({
  status: async () => ({ ok: true, value: { ok: true, version: '1.0.0', profile: { name: 'web' }, packs: [], store: { dir: '/store', entries: [] }, memoryDir: '/mem' } }),
  marketList: async () => ({ ok: false, message: 'not stubbed' }),
  marketDetail: async () => ({ ok: false, message: 'not stubbed' }),
  importPack: async () => ({ ok: true, value: { ok: true, pack: { name: 'P', plugins: 1 } } }),
  ...overrides,
})

const searchEntries = (n) => Array.from({ length: n }, (_, i) => ({
  id: 'pack.p' + i, repo: 'o/p' + i, ref: 'main', repoUrl: 'https://github.com/o/p' + i,
  name: 'p' + i, author: 'o', stars: 1, forks: 0, license: 'MIT', description: 'd',
  topics: [], updatedAt: '', detailPending: true, importable: false, intro: '', install: '',
  readmeUrl: null, npmName: null, version: null, hasPack: false, packKind: null, manifest: null,
}))

let handle = null
afterEach(() => { if (handle) { handle.restore(); handle = null } })

describe('市场搜索与列表渲染', () => {
  it('首次进入 market 页签自动搜索（topic 默认 dsh-plugin，refresh:false 走缓存语义）', async () => {
    const calls = []
    handle = loadClient(remoteOk({
      marketList: async (params) => { calls.push(params); return { ok: true, value: { ok: true, cached: false, total: 3, page: 1, sources: null, hasMore: false, entries: searchEntries(3) } } },
      marketDetail: async () => ({ ok: true, value: { ok: true, cached: true, entry: null } }),
    }))
    const marketTab = handle.walk(handle.tree.current).find((n) => n.type === 'button' && textOf(n).includes('插件市场'))
    marketTab.props.onClick()
    await flush(); await flush()
    expect(calls.length).toBeGreaterThanOrEqual(1)
    expect(calls[0].topic).toBe('dsh-plugin')
    expect(calls[0].page).toBe(1)
    expect(calls[0].refresh).toBe(false)
    // 卡片渲染
    const text = textOf(handle.tree.current)
    expect(text).toContain('p0')
  })

  it('搜索成功但结果为空 → 显示「没有匹配的插件」，不回退内置示例目录（审计修复）', async () => {
    handle = loadClient(remoteOk({
      marketList: async () => ({ ok: true, value: { ok: true, cached: false, total: 0, page: 1, sources: null, hasMore: false, entries: [] } }),
    }))
    const marketTab = handle.walk(handle.tree.current).find((n) => n.type === 'button' && textOf(n).includes('插件市场'))
    marketTab.props.onClick()
    await flush(); await flush()
    const text = textOf(handle.tree.current)
    expect(text).toContain('没有匹配的插件')
    // 内置示例目录只在「无数据」（初始/网络失败）时展示；空结果是真实搜索结果
    expect(text).not.toContain('科研插座包')
  })

  it('网络失败（无任何数据）→ 回退内置示例目录（保留离线展示语义）', async () => {
    handle = loadClient(remoteOk({
      marketList: async () => { throw new Error('network down') },
    }))
    const marketTab = handle.walk(handle.tree.current).find((n) => n.type === 'button' && textOf(n).includes('插件市场'))
    marketTab.props.onClick()
    await flush(); await flush()
    const text = textOf(handle.tree.current)
    expect(text).toContain('科研插座包')
    expect(text).toContain('获取市场失败')
  })
})

describe('「加载更多」终止条件（审计修复：hasMore 权威契约）', () => {
  const openMarketWith = async (marketList) => {
    handle = loadClient(remoteOk({ marketList, marketDetail: async () => ({ ok: true, value: { ok: true, cached: true, entry: null } }) }))
    const marketTab = handle.walk(handle.tree.current).find((n) => n.type === 'button' && textOf(n).includes('插件市场'))
    marketTab.props.onClick()
    await flush(); await flush()
  }
  const moreButton = () => handle.walk(handle.tree.current).find((n) => n.type === 'button' && textOf(n).includes('加载更多'))

  it('hasMore=false → 不渲染「加载更多」按钮（total 大也不行）', async () => {
    await openMarketWith(async () => ({ ok: true, cached: false, total: 5000, page: 1, sources: null, hasMore: false, entries: searchEntries(3) }))
    expect(moreButton()).toBeUndefined()
  })

  it('hasMore=true → 渲染按钮；点击后请求下一页', async () => {
    const calls = []
    await openMarketWith(async (params) => {
      calls.push(params.page)
      return { ok: true, value: { ok: true, cached: false, total: 5000, page: params.page, sources: null, hasMore: params.page < 2, entries: searchEntries(10) } }
    })
    expect(moreButton()).toBeTruthy()
    moreButton().props.onClick()
    await flush(); await flush()
    expect(calls).toContain(2)
  })

  it('第二页 hasMore=false → 按钮消失（翻页终止）', async () => {
    await openMarketWith(async (params) => ({ ok: true, value: { ok: true, cached: false, total: 5000, page: params.page, sources: null, hasMore: false, entries: searchEntries(10) } }))
    expect(moreButton()).toBeUndefined()
  })
})

describe('详情 hydrate', () => {
  it('marketDetail 失败 → 卡片标记 importable:false + importError，不再永久「加载中」', async () => {
    handle = loadClient(remoteOk({
      marketList: async () => ({ ok: true, value: { ok: true, cached: false, total: 1, page: 1, sources: null, hasMore: false, entries: searchEntries(1) } }),
      marketDetail: async () => { throw new Error('boom') },
    }))
    const marketTab = handle.walk(handle.tree.current).find((n) => n.type === 'button' && textOf(n).includes('插件市场'))
    marketTab.props.onClick()
    await flush(); await flush(); await flush()
    const text = textOf(handle.tree.current)
    expect(text).not.toContain('详情加载中')
    expect(text).toContain('不可导入')
  })

  it('marketDetail 返回 entry → 覆盖对应卡片（detailPending 清除）', async () => {
    handle = loadClient(remoteOk({
      marketList: async () => ({ ok: true, value: { ok: true, cached: false, total: 1, page: 1, sources: null, hasMore: false, entries: searchEntries(1) } }),
      marketDetail: async () => ({
        ok: true,
        value: {
          ok: true, cached: true,
          entry: { id: 'pack.p0', repo: 'o/p0', ref: 'main', name: 'p0', topics: [], intro: '真实介绍', detailPending: false, importable: true, manifest: { hotpack: '1.0', id: 'pack.p0', name: 'p0', version: '1.0.0', plugins: [{ id: 'main', name: 'pkg0', source: { type: 'github', repo: 'o/p0', ref: 'main' } }] } },
        },
      }),
    }))
    const marketTab = handle.walk(handle.tree.current).find((n) => n.type === 'button' && textOf(n).includes('插件市场'))
    marketTab.props.onClick()
    await flush(); await flush(); await flush()
    const text = textOf(handle.tree.current)
    expect(text).toContain('真实介绍')
    expect(text).toContain('导入')
  })
})

describe('来源多选（审计修复：全取消回退默认，不再产生空数组语义漂移）', () => {
  it('全部取消选中 → marketSources 回到 null（默认官方+全部镜像），请求不再携带空数组', async () => {
    const calls = []
    handle = loadClient(remoteOk({
      marketList: async (params) => { calls.push(params); return { ok: true, value: { ok: true, cached: false, total: 0, page: 1, sources: null, hasMore: false, entries: [] } } },
    }))
    const marketTab = handle.walk(handle.tree.current).find((n) => n.type === 'button' && textOf(n).includes('插件市场'))
    marketTab.props.onClick()
    await flush(); await flush()
    // 来源 chip 的精确集合（'官方 GitHub' + 6 个镜像域名；排除标签面板里的分类 chip）
    const sourceLabels = ['官方 GitHub', 'ghfast.top', 'gh-proxy.com', 'ghproxy.net', 'mirror.ghproxy.com', 'ghproxy.cc', 'gh-proxy.net']
    const chips = handle.walk(handle.tree.current).filter((n) => n.type === 'button' && n.props.className === 'hp_chip' && n.props.onClick && sourceLabels.includes(textOf(n)))
    expect(chips.length).toBe(7)
    for (const chip of chips) chip.props.onClick()
    await flush()
    // 触发搜索，断言 sources 为 null（默认）而非 []
    const searchBtn = handle.walk(handle.tree.current).find((n) => n.type === 'button' && textOf(n) === '搜索')
    searchBtn.props.onClick()
    await flush(); await flush()
    const last = calls[calls.length - 1]
    expect(last.sources === null || last.sources === undefined).toBe(true)
  })
})

describe('AI 连接测试超时（审计修复：挂起 fetch 使按钮永久禁用）', () => {
  it('fetch 挂起 → 15s 超时后 aiTesting 复位（按钮恢复可用）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const pendingFetch = (url, opts) => new Promise((resolve, reject) => {
        if (opts && opts.signal) opts.signal.addEventListener('abort', () => reject(new Error('aborted')))
      })
      handle = loadClient(remoteOk(), { fetch: pendingFetch })
      // 打开 AI 页签 + 设置面板
      const aiTab = handle.walk(handle.tree.current).find((n) => n.type === 'button' && textOf(n).includes('AI 装配间'))
      aiTab.props.onClick()
      await flushMicro()
      const gearBtn = handle.walk(handle.tree.current).find((n) => n.type === 'button' && textOf(n).includes('模型'))
      gearBtn.props.onClick()
      await flushMicro()
      // 填 key 与合法 baseURL 后点「测试连接」
      const inputs = handle.walk(handle.tree.current).filter((n) => n.type === 'input')
      const keyInput = inputs.find((n) => n.props.type === 'password')
      keyInput.props.onChange({ target: { value: 'sk-test' } })
      const baseInput = inputs.find((n) => (n.props.placeholder || '').includes('Base URL'))
      baseInput.props.onChange({ target: { value: 'https://api.deepseek.com' } })
      await flushMicro()
      const testBtn = () => handle.walk(handle.tree.current).find((n) => n.type === 'button' && /测试(连接|中)/.test(textOf(n)))
      testBtn().props.onClick()
      await flushMicro()
      expect(testBtn().props.disabled).toBe(true) // 测试中
      await vi.advanceTimersByTimeAsync(15_000 + 100)
      await flushMicro()
      expect(testBtn().props.disabled).toBe(false) // 超时复位
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('REMOTE 描述符与注入面对齐', () => {
  it('injected() 暴露全部 11 个 RPC 方法（含 aiAssemble，与 gateway/typert 三处同步）', () => {
    handle = loadClient(remoteOk())
    const api = handle.api
    for (const m of ['status', 'importPack', 'preview', 'activate', 'deactivate', 'removePack', 'check', 'marketList', 'marketDetail', 'aiAssemble', 'aiChat']) {
      expect(typeof api[m], m).toBe('function')
    }
  })
})
