// test/prototype-ai.test.mjs — prototype.html（桌面端 UI，EXE 内嵌资源）AI 装配间测试
//
// prototype.html 是单文件应用（4600+ 行），无模块导出。此处提取 <script> 源码，
// 在 node:vm 独立 realm（每用例全新全局，无跨用例状态泄漏）中注入最小 DOM 桩后
// 执行，直接调用其真实函数：LLM 响应分类、会话恢复与 msgSeq 重算（产物卡错绑
// 修复）、connNote 转义（XSS 修复）、本地模拟产物的插件 id 合法性（mock pid 修复）、
// 空态人设持久化、纯函数与后端契约一致性、compose 守卫。
// v4（一体总控台大面板）契约：AI 装配间常驻主页左栏 #homeAiPanel（renderAi 的
// 渲染容器），产物卡事件委托挂静态外壳 #view-home（renderHome 只重建 innerHTML
// 不换节点，绑定一次永不失效），switchView('ai') 转义回主页。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const htmlPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'dsh-pack-hub', 'prototype.html')
const html = readFileSync(htmlPath, 'utf8')
const scriptSrc = html.match(/<script>([\s\S]*?)<\/script>/)[1]

/* ---------------- DOM/浏览器桩 ---------------- */
function makeEl(id = '') {
  const el = {
    id,
    children: [],
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    value: '',
    textContent: '',
    innerHTML: '',
    placeholder: '',
    disabled: false,
    scrollTop: 0,
    scrollHeight: 100,
    clientHeight: 100,
    _listeners: {},
    addEventListener(type, fn) { (el._listeners[type] = el._listeners[type] || []).push(fn) },
    removeEventListener(type, fn) {
      el._listeners[type] = (el._listeners[type] || []).filter((f) => f !== fn)
    },
    dispatch(type, ev) { for (const fn of el._listeners[type] || []) fn(ev) },
    appendChild(c) { el.children.push(c); return c },
    removeChild(c) { el.children = el.children.filter((x) => x !== c) },
    remove() {},
    insertAdjacentHTML(_pos, markup) { el.innerHTML += markup },
    setAttribute() {},
    getAttribute() { return null },
    closest() { return null },
    focus() {},
    click() {},
    querySelector() { return null },
    querySelectorAll() { return [] },
  }
  return el
}

/**
 * 在全新 vm realm 中加载 prototype 脚本。
 * @param {Map} storageData localStorage 预置数据
 * @returns {{ g: object, elements: Map, storage: Map }} g=上下文全局（函数声明挂在
 *   global 对象上；let/const 全局词法绑定经 getter 取）
 */
function loadPrototype(storageData = new Map()) {
  const elements = new Map()
  const storage = {
    _m: storageData,
    getItem: (k) => (storageData.has(k) ? storageData.get(k) : null),
    setItem: (k, v) => storageData.set(k, String(v)),
    removeItem: (k) => storageData.delete(k),
  }
  const documentStub = {
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, makeEl(id))
      return elements.get(id)
    },
    // renderShell 会取 .topbar 写入标题——桩按需供给，其余选择器维持 null
    querySelector: (sel) => (sel === '.topbar' ? documentStub.getElementById('topbar') : null),
    querySelectorAll: () => [],
    createElement: (t) => makeEl(t),
    body: makeEl('body'),
    documentElement: makeEl('html'),
    activeElement: null,
    addEventListener() {},
  }
  const sandbox = {
    document: documentStub,
    localStorage: storage,
    navigator: { clipboard: { writeText: async () => {} }, userAgent: 'vitest' },
    confirm: () => true,
    requestAnimationFrame: (fn) => fn(),
    scrollTo: () => {},
    // 市场视图自动抓取（switchView('market') 触发）所需的浏览器 API 桩：fetch 立即拒绝，
    // 走市场错误分支（确定性，不产生未处理拒绝）
    AbortController,
    fetch: () => Promise.reject(new Error('fetch disabled in vm stub')),
    // 动态转发到宿主 setTimeout：vi.useFakeTimers 的桩对 vm 内代码同样生效
    setTimeout: (fn, ms, ...a) => setTimeout(fn, ms, ...a),
    clearTimeout: (t) => clearTimeout(t),
    console,
    URL,
    Blob: class { constructor(parts) { this._s = String(parts[0] ?? '') } },
    location: { href: 'file:///prototype.html', reload() {} },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    __proto__: null,
  }
  sandbox.window = sandbox
  vm.createContext(sandbox)
  vm.runInContext(scriptSrc, sandbox, { timeout: 15000 })
  // 全局词法绑定（let aiSession / let aiMessages…）经上下文内 eval 取回
  const readGlobal = vm.runInContext('(name) => eval(name)', sandbox)
  // vm 顶层 let/const 是全局词法绑定（不在 sandbox 对象上）：写入须经上下文内赋值路由
  const writeGlobal = (name, value) => {
    sandbox.__v = value
    vm.runInContext(name + ' = __v', sandbox)
  }
  const g = new Proxy(sandbox, {
    get(target, prop) {
      if (prop in target) return target[prop]
      return readGlobal(String(prop))
    },
    set(_target, prop, value) {
      writeGlobal(String(prop), value)
      return true
    },
  })
  return { g, elements, storage: storageData }
}

let ctx = null
beforeEach(() => {
  ctx = loadPrototype()
})
afterEach(() => {
  vi.useRealTimers()
})

const validPackFixture = () => ({
  hotpack: '1.0',
  id: 'pack.ai.proto',
  name: '原型测试包',
  version: '0.1.0',
  description: 'd',
  tags: ['测试'],
  plugins: [{ id: 'note', name: 'dsh-notes', version: '1.0.0', source: { type: 'npm' }, config: {} }],
})

describe('LLM 原文分类（classifyAiRaw，与后端 aiChat 同语义）', () => {
  it('合法清单 → product；有 JSON 但非法 → invalid；对话轮纯文本 → chat', () => {
    expect(ctx.g.classifyAiRaw(JSON.stringify(validPackFixture()), true).status).toBe('product')
    expect(ctx.g.classifyAiRaw(JSON.stringify({ ...validPackFixture(), plugins: [] }), true).status).toBe('invalid')
    expect(ctx.g.classifyAiRaw('```json\n{"broken":\n', true).status).toBe('invalid')
    expect(ctx.g.classifyAiRaw('好的主人，这就为您调整～', false).status).toBe('chat')
  })

  it('首轮纯文本（无 JSON）→ invalid（首轮必须产出清单）', () => {
    expect(ctx.g.classifyAiRaw('我需要更多信息', true).status).toBe('invalid')
  })
})

describe('会话恢复与 msgSeq 重算（产物卡错绑修复）', () => {
  it('恢复带 uid 的旧消息后，新消息 uid 不与旧消息冲突', () => {
    const room = {
      session: { id: 'ai-old', persona: 'maid', messages: [{ role: 'user', content: 'hi' }], pack: null },
      messages: [
        { role: 'user', text: 'hi', uid: 'm1' },
        { role: 'assistant', text: 'ok', uid: 'm5', persona: 'maid' },
      ],
    }
    ctx.storage.set('dshAiRoom', JSON.stringify(room))
    expect(ctx.g.aiRestore()).toBe(true)
    ctx.g.finishAssistTurn('新的回复', null, null, 'maid', null)
    const last = ctx.g.aiMessages[ctx.g.aiMessages.length - 1]
    expect(last.uid).toBe('m6') // 此前 msgSeq 从 0 重来 → 'm1' 撞车 → 产物卡错绑
  })

  it('损坏的 dshAiRoom → 恢复失败但不抛错（清空态）', () => {
    ctx.storage.set('dshAiRoom', '{not json')
    expect(ctx.g.aiRestore()).toBe(false)
  })
})

describe('connNote 转义（XSS 修复）', () => {
  it('模型名注入标记 → renderAi 输出被转义（无 <img/onerror 原文）', () => {
    ctx.g.aiModelMem = '"><img src=x onerror=alert(1)>'
    ctx.g.renderAi()
    const out = ctx.elements.get('homeAiPanel').innerHTML
    // 安全属性：注入内容中没有原生标签起始（<img 被转义为 &lt;img，成为惰性文本）
    expect(out).toContain('&lt;img')
    expect(out).not.toContain('<img')
  })

  it('正常模型名 → 连接状态行包含模型名与平台标签', () => {
    ctx.g.aiProviderSel = 'opencode'
    ctx.g.aiModelMem = 'deepseek-v4-flash'
    ctx.g.renderAi()
    const out = ctx.elements.get('homeAiPanel').innerHTML
    expect(out).toContain('deepseek-v4-flash')
    expect(out).toContain('OpenCode')
  })
})

describe('本地模拟（无 Key）产物契约', () => {
  it('mock 产物插件 id 全部合法（英文小写，符合 hotpack 1.0 id 规则）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    ctx.g.document.getElementById('reqInput').value = '我要整理读书笔记：双链引用、全文搜索、自动背卡'
    ctx.g.document.getElementById('aiPersona').value = 'maid'
    const p = ctx.g.compose()
    await vi.advanceTimersByTimeAsync(5 * 420 + 100)
    await p
    const assistantMsg = ctx.g.aiMessages.find((m) => m.role === 'assistant' && m.pack)
    expect(assistantMsg).toBeTruthy()
    const ids = assistantMsg.pack.plugins.map((pl) => pl.id)
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids) expect(id).toMatch(/^[a-z0-9][a-z0-9_-]{0,39}$/)
    // mock 会话内的 hotpack 清单能通过页面权威校验（此前中文 role 恒非法）
    expect(ctx.g.parseHotpackJson(JSON.stringify(assistantMsg.pack))).toBeTruthy()
  })

  it('mock 首轮后 aiSession.pack 与产物一致并持久化到 dshAiRoom', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    ctx.g.document.getElementById('reqInput').value = '科研文献工作流'
    ctx.g.document.getElementById('aiPersona').value = 'assistant'
    const p = ctx.g.compose()
    await vi.advanceTimersByTimeAsync(5 * 420 + 100)
    await p
    expect(ctx.g.aiSession && ctx.g.aiSession.pack).toBeTruthy()
    const saved = JSON.parse(ctx.storage.get('dshAiRoom'))
    expect(saved.session.pack.plugins.length).toBe(ctx.g.aiSession.pack.plugins.length)
  })
})

describe('空态人设持久化（修复：会话未建时切换不再丢失）', () => {
  it('setAiPersonaSel 写入 dshAiPersona；renderAi 空态用持久化人设的欢迎语', () => {
    expect(ctx.g.aiSession).toBeNull()
    ctx.g.setAiPersonaSel('neko')
    expect(ctx.storage.get('dshAiPersona')).toBe('neko')
    ctx.g.renderAi()
    expect(ctx.elements.get('homeAiPanel').innerHTML).toContain('咪咪') // neko 欢迎语
  })
})

describe('纯函数与后端契约一致性', () => {
  it('esc：五个 HTML 危险字符全部转义', () => {
    expect(ctx.g.esc('<>"\'&')).toBe('&lt;&gt;&quot;&#39;&amp;')
  })

  it('parseHotpackJson 与后端权威校验同一批用例同判', () => {
    const ok = validPackFixture()
    expect(ctx.g.parseHotpackJson(JSON.stringify(ok))).toBeTruthy()
    expect(ctx.g.parseHotpackJson(JSON.stringify({ ...ok, plugins: [] }))).toBeNull()
    expect(ctx.g.parseHotpackJson(JSON.stringify({ ...ok, version: 'latest' }))).toBeNull()
    expect(ctx.g.parseHotpackJson(JSON.stringify({ ...ok, plugins: [{ ...ok.plugins[0], id: '中文ID' }] }))).toBeNull()
    // 审计对齐：包级版本必须 semver；npm 插件版本必填；id/name 大小写不敏感去重；空白名拒绝
    expect(ctx.g.parseHotpackJson(JSON.stringify({ ...ok, plugins: [{ ...ok.plugins[0], version: 'latest' }] }))).toBeNull()
    expect(ctx.g.parseHotpackJson(JSON.stringify({ ...ok, plugins: [{ ...ok.plugins[0], version: undefined }] }))).toBeNull()
    expect(ctx.g.parseHotpackJson(JSON.stringify({ ...ok, plugins: [...ok.plugins, { id: 'NOTE', name: 'dsh-notes', version: '1.0.0', source: { type: 'npm' }, config: {} }] }))).toBeNull()
    expect(ctx.g.parseHotpackJson(JSON.stringify({ ...ok, name: '   ' }))).toBeNull()
  })

  it('diffHotpack：新增/移除/调整三分类', () => {
    const base = validPackFixture()
    const next = {
      ...base,
      plugins: [
        { id: 'note', name: 'dsh-notes', version: '1.1.0', source: { type: 'npm' }, config: {} },
        { id: 'search', name: 'dsh-search', version: '2.0.0', source: { type: 'npm' }, config: {} },
      ],
    }
    const d = ctx.g.diffHotpack(base, next)
    expect(d.added.map((p) => p.id)).toEqual(['search'])
    expect(d.removed).toHaveLength(0)
    expect(d.changed.map((c) => c.id)).toEqual(['note'])
  })

  it('keywordHits：四类示例需求都能命中场景；无关内容零命中', () => {
    expect(ctx.g.keywordHits('我要整理读书笔记：双链引用、全文搜索').length).toBeGreaterThan(0)
    expect(ctx.g.keywordHits('视频剪辑字幕').length).toBeGreaterThan(0)
    expect(ctx.g.keywordHits('考研背诵闪卡').length).toBeGreaterThan(0)
    expect(ctx.g.keywordHits('完全无关的内容xyz')).toHaveLength(0)
  })

  it('aiErrorText：四个人设的失败文案都含原因与重试指引', () => {
    for (const p of ['maid', 'butler', 'neko', 'assistant']) {
      const text = ctx.g.aiErrorText(p, '产物校验失败', true)
      expect(text).toContain('校验失败')
      expect(text.length).toBeGreaterThan(6)
    }
  })

  it('extractJson（页面版）：围栏/裸 JSON/纯文本与后端语义一致', () => {
    expect(ctx.g.extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(ctx.g.extractJson('说明 {"b":2} 结束')).toEqual({ b: 2 })
    expect(ctx.g.extractJson('纯文本')).toBeNull()
  })
})

describe('compose 守卫', () => {
  it('aiRunning 期间重复 compose 被拦截（不产生新一轮）', () => {
    ctx.g.aiRunning = true
    ctx.g.document.getElementById('reqInput').value = '再来一次'
    ctx.g.compose()
    expect(ctx.g.aiMessages.filter((m) => m.role === 'user')).toHaveLength(0)
  })

  it('空输入直接返回（不发请求不建会话）', () => {
    ctx.g.document.getElementById('reqInput').value = '   '
    ctx.g.compose()
    expect(ctx.g.aiMessages).toHaveLength(0)
    expect(ctx.g.aiSession).toBeNull()
  })
})

/* ================ v4 一体总控台大面板契约（本轮审计新增） ================ */

describe('v4 导航契约：switchView 与旧状态迁移', () => {
  it("switchView('ai') 转义为主页（AI 装配间常驻主页，不再是独立视图）", () => {
    ctx.g.switchView('ai')
    expect(ctx.g.currentView).toBe('home')
    expect(ctx.storage.get('dsh-pack-hub-prototype')).toContain('"currentView":"home"')
  })

  it('旧会话残留在 ai 视图 → 迁移回主页，且女仆坞时代的 maidDockOpen 键被清理', () => {
    const legacy = loadPrototype(new Map([['dsh-pack-hub-prototype', JSON.stringify({ currentView: 'ai', maidDockOpen: true })]]))
    expect(legacy.g.currentView).toBe('home')
    // save() 全量序列化 state：死键若不迁移将永久残留 localStorage
    legacy.g.save()
    expect(JSON.parse(legacy.storage.get('dsh-pack-hub-prototype')).maidDockOpen).toBeUndefined()
  })
})

describe('v4 主页大面板：renderHome 内嵌渲染 AI 常驻舱', () => {
  it('renderHome 产出 .home-console + #homeAiPanel，并立即填充 AI 装配间（renderAi 容器契约）', () => {
    ctx.g.renderHome()
    const home = ctx.elements.get('view-home').innerHTML
    expect(home).toContain('home-console')
    expect(home).toContain('id="homeAiPanel"')
    // renderHome 末尾调用 renderAi：左栏被填充为装配间（工具栏/输入坞/滚动区）
    const panel = ctx.elements.get('homeAiPanel').innerHTML
    expect(panel).toContain('ai-zone')
    expect(panel).toContain('id="reqInput"')
    expect(panel).toContain('id="composeBtn"')
    expect(panel).toContain('id="aiScroll"')
  })

  it('重复 renderHome 每次都重新填充左栏（切回主页/插件回推重绘语义）', () => {
    ctx.g.renderHome()
    ctx.elements.get('homeAiPanel').innerHTML = '' // 模拟旧内容被丢弃
    ctx.g.renderHome()
    expect(ctx.elements.get('homeAiPanel').innerHTML).toContain('ai-zone')
  })
})

describe('v4 产物卡事件委托：挂静态 #view-home，重绘不丢（本轮审计修复）', () => {
  /** 构造一条带产物的消息并渲染，返回可点击的事件目标桩（closest 命中所属卡片）。 */
  const seedCard = () => {
    const manifest = {
      packId: 'pack.ai.deleg', name: '委托测试包', version: '0.1.0', tags: ['t'],
      bundles: [{ name: 'dsh-notes', version: '1.0.0', role: 'note' }],
    }
    ctx.g.aiMessages = [{ role: 'assistant', text: 'ok', uid: 'm1', persona: 'maid', pack: null, result: { manifest, readme: '# r' } }]
    ctx.g.aiSession = { id: 's1', persona: 'maid', messages: [], pack: null }
    ctx.g.renderHome() // renderHome → renderAi → bindResultActions
  }
  const clickCardBtn = (cls) => {
    const zone = ctx.elements.get('view-home')
    const card = { getAttribute: () => 'm1' }
    let captured = ''
    const target = { closest: (sel) => (sel === '.ai-pack-card' ? card : (sel === cls ? {} : null)) }
    ctx.g.navigator.clipboard.writeText = async (t) => { captured = t }
    zone.dispatch('click', { target })
    return captured
  }

  it('委托绑定在静态 view-home 上（而非会被 renderHome 重建的 homeAiPanel）', () => {
    seedCard()
    expect(ctx.g.aiActionsBound).toBe(true)
    // ≥1：静态外壳上存在委托（未来若有第二个合法委托不受限）；homeAiPanel 上必须为 0（真契约）
    expect((ctx.elements.get('view-home')._listeners.click || []).length).toBeGreaterThanOrEqual(1)
    expect((ctx.elements.get('homeAiPanel')._listeners.click || []).length).toBe(0)
  })

  it('renderHome 重建 #homeAiPanel 后，产物卡按钮仍经委托生效（修复：二次进主页不失效）', () => {
    seedCard()
    ctx.g.switchView('hub')   // 离开主页
    ctx.g.switchView('home')  // 回主页：view-home innerHTML 重建，homeAiPanel 换新节点
    const copied = clickCardBtn('.ai-act-copy-manifest')
    expect(copied).toContain('packId')
    expect(copied).toContain('pack.ai.deleg')
  })

  it('委托链导入按钮全链路：点击 ai-act-import → importPacks 入库（confirm 桩接受）', () => {
    seedCard()
    ctx.g.switchView('market')
    ctx.g.switchView('home')
    const zone = ctx.elements.get('view-home')
    const card = { getAttribute: () => 'm1' }
    zone.dispatch('click', { target: { closest: (sel) => (sel === '.ai-pack-card' ? card : (sel === '.ai-act-import' ? {} : null)) } })
    expect(ctx.g.state.imported.length).toBe(1)
    expect(ctx.g.state.imported[0].id).toBe('pack.ai.deleg') // importPacks 入库形态：{ id, name, bundles… }
    expect(ctx.g.state.imported[0].bundles.length).toBe(1)
  })

  it('无匹配消息 uid 的卡片点击 → 明确提示数据缺失（不抛错、不误操作）', () => {
    seedCard()
    const zone = ctx.elements.get('view-home')
    const card = { getAttribute: () => 'm-not-exist' }
    let toasted = ''
    ctx.g.toast = (t) => { toasted = t }
    zone.dispatch('click', { target: { closest: (sel) => (sel === '.ai-pack-card' ? card : (sel === '.ai-act-copy-manifest' ? {} : null)) } })
    expect(toasted).toContain('缺失')
  })
})

describe('v4 顶部横排主导航（renderMainNav 契约）', () => {
  it('渲染 9 个视图项（AI 装配间不入主导航），当前项高亮', () => {
    ctx.g.switchView('home')
    const nav = ctx.elements.get('mainNav').innerHTML
    expect((nav.match(/class="nav-item /g) || []).length).toBe(9)
    expect(nav).toContain('data-view="home"')
    expect(nav).toContain('data-view="theme"')
    expect(nav).not.toContain('data-view="ai"')
    expect(nav.match(/nav-item active/) !== null).toBe(true)
  })
})

describe('v4 布局契约（CSS 静态断言；真实几何由 scripts/qa11/qa12 浏览器验收）', () => {
  it('AI 常驻舱 sticky 化 + 总控台不再裁剪滚动（根治工具栏被吸顶头埋没）', () => {
    const cols = html.match(/\.home-ai-col\s*\{[^}]*\}/g) || []
    // 桌面主规则：sticky + 视口锚定高度（断言与格式无关，空白容忍；真实几何由 qa11/qa12 验收）
    expect(cols.some((c) => c.includes('position: sticky') && /height:\s*calc\(100vh/.test(c))).toBe(true)
    const consoleRule = html.match(/\.home-console\s*\{[^}]*\}/)[0]
    expect(consoleRule).not.toContain('overflow: hidden')
  })

  it('≤720px 断点：总控台纵向堆叠（.pcl-home 死规则已清理）+ 窄屏标题对齐', () => {
    const medias = html.match(/@media \(max-width: 720px\)\s*\{[\s\S]*?\n\}/g) || []
    expect(medias.length).toBeGreaterThan(0)
    expect(medias.some((m) => /\.home-console\s*\{\s*grid-template-columns:\s*1fr;?\s*\}/.test(m)), '末尾响应块须含总控台堆叠').toBe(true)
    expect(medias.some((m) => m.includes('.pcl-home')), '.pcl-home 死规则应已清理').toBe(false)
    expect(medias.some((m) => m.includes('body.on-home .topbar')), '窄屏标题对齐规则').toBe(true)
    // 桌面断点：主页标题与大面板左缘对齐（44 = wrap 22 + shell 22）
    expect(html).toMatch(/body\.on-home\s+\.topbar\s*\{\s*padding-left:\s*44px;?\s*\}/)
  })
})
