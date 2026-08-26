#!/usr/bin/env node
/**
 * scripts/qa13-shell-injection.mjs — 桌面壳注入脚本健壮性验收（v1.1 · PC15；本地/CI 均可跑）
 *
 * 做法：从 release/src/Main.cs 原样提取两段注入 JS（与 qa7 同款字面量提取法），
 * 在 Node vm 的极简 DOM 沙箱里执行——不依赖浏览器/EXE，直接验证注入脚本自身行为：
 *
 * 覆盖：
 *   A. BuildApiIntegrationScript（AI 渠道）：
 *      A1 完整页面桩：compose 组装 'ai:' 负载（text/model/persona/system/history/pack/apiKey/baseURL）；
 *      A2 页面半失败（renderAi/compose/beginTurn/aiSession 全部缺失）：注入不抛错（PC15 主断言：
 *         旧实现 `var origRenderAi=renderAi` 裸引用 ReferenceError 级联失效）；
 *      A3 beginTurn 缺失但 compose 存在：回退调用原 compose；
 *      A4 __onAiResult / __onAiError 在组件缺失时不抛错（toast/aiTyping 兜底路径）；
 *      A5 未配置 Key：failAssistTurn 提示、不发 'ai:' 请求。
 *   B. BuildNativeSelfCheckScript（自检注入）：
 *      B1 无 state/getChecks 的裸页面：不抛错（既有守卫回归锁定）；
 *      B2 getChecks 存在：猴补丁回填真实探测行（Node.js/pnpm）。
 *
 * 用法：node scripts/qa13-shell-injection.mjs
 */
import { readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mainCs = readFileSync(join(ROOT, 'release', 'src', 'Main.cs'), 'utf8')

let passes = 0
let failures = 0
function check(cond, name) {
  if (cond) { passes++; console.log('  ok: ' + name) }
  else { failures++; console.log('  FAIL ' + name) }
}

// ---- 从 Main.cs 提取 C# 字符串字面量拼接的注入 JS（qa7 同款） ----
function extractScript(startMarker, endMarker, label) {
  const sIdx = mainCs.indexOf(startMarker)
  const eIdx = mainCs.indexOf(endMarker, sIdx)
  if (sIdx < 0 || eIdx < 0) { console.error('FAIL 无法提取 ' + label); process.exit(2) }
  const segment = mainCs.slice(sIdx, eIdx + endMarker.length)
  const literals = [...segment.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1])
  if (literals.some((l) => l.includes('\\'))) { console.error('FAIL ' + label + ' 含转义字符'); process.exit(2) }
  return literals.join('')
}

const apiJsTemplate = extractScript('"window.__apiConfig=', '"})()}catch(e){}";', 'BuildApiIntegrationScript')
// 头部 15 个字段的值是 C# 内插（JsString(...) 调用），字面量提取后留下 `field:,` 空位——
// mock 回填（探测值本身不是被测行为，被测的是注入脚本的守卫与回填逻辑）。
const selfCheckJsRaw = extractScript('"window.__nativeSelfCheck={', '"})();}catch(e){}"', 'BuildNativeSelfCheckScript')
function fillSelfCheck(fields = {}) {
  return selfCheckJsRaw.replace(/([A-Za-z0-9_]+):(,|})/g, (m, name, tail) =>
    name + ':' + JSON.stringify(fields[name] ?? null) + tail)
}

// ---- 沙箱工厂：极简 DOM 桩 ----
function makeSandbox({ inputs = {}, page = {}, hasShellKey = true } = {}) {
  const posted = []
  const els = {
    reqInput: { value: inputs.text ?? '  组装一个文献插件  ', style: {} },
    aiPersona: { value: inputs.persona ?? 'maid' },
    aiModelInput: { value: inputs.model ?? '' },
    aiKeyInput: { value: inputs.key ?? '' },
    aiBaseUrlInput: { value: inputs.baseUrl ?? '' },
    aiConnNote: null,
    aiTyping: null,
  }
  const document = {
    readyState: 'complete',
    getElementById: (id) => els[id] ?? null,
  }
  const sandbox = {
    document,
    window: {},
    console,
    ...page,
  }
  sandbox.window.chrome = { webview: { postMessage: (m) => posted.push(m) } }
  sandbox.window.chrome = sandbox.window.chrome // 保留引用
  Object.defineProperty(sandbox, 'window', { value: sandbox.window, writable: true })
  sandbox.window.__sandbox = sandbox
  const js = apiJsTemplate
    .replace(/window\.__apiConfig=[^;]*;/, 'window.__apiConfig=' + JSON.stringify({
      provider: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com/v1', models: 'deepseek-chat',
      defaultModel: 'deepseek-chat', temperature: 0.8, apiKey: '',
    }) + ';')
    .replace(/var HAS_SHELL_KEY=[^;]*;/, 'var HAS_SHELL_KEY=' + (hasShellKey ? 'true' : 'false') + ';')
  return { sandbox, posted, js }
}

console.log('== A. BuildApiIntegrationScript（AI 渠道注入） ==')

// A1 完整页面桩：compose 组装 ai: 负载
{
  let beginTurnCalls = 0
  const { sandbox, posted, js } = makeSandbox({
    page: {
      renderAi: () => {},
      refreshConnNote: () => {},
      compose: () => { throw new Error('不应调用原 compose（webview 渠道优先）') },
      beginTurn: () => { beginTurnCalls++ },
      buildAiSystem: (persona, mode) => 'SYS:' + persona + ':' + mode,
      aiSession: { messages: [{ role: 'user', text: '第一轮' }, { role: 'assistant', text: '好' }, { role: 'user', text: '前一轮' }], pack: { hotpack: '1.0', id: 'pack.x' } },
      aiMessages: [{ role: 'user', text: '当前这轮' }],
      aiRunning: false,
      processAiRaw: () => {},
      failAssistTurn: () => {},
      aiErrorText: (p, m) => m,
      toast: () => {},
    },
  })
  vm.runInContext(js, vm.createContext(sandbox), { timeout: 5000 })
  sandbox.compose()
  check(beginTurnCalls === 1, 'A1 beginTurn 恰好调用一次')
  check(posted.length === 1 && posted[0].startsWith('ai:'), 'A1 发出一条 ai: 请求')
  if (posted.length === 1) {
    const payload = JSON.parse(posted[0].slice(3))
    check(payload.text === '组装一个文献插件', 'A1 负载 text（trim 后）')
    check(payload.persona === 'maid', 'A1 负载 persona')
    check(payload.model === 'deepseek-chat', 'A1 模型回退 cfg.defaultModel')
    check(typeof payload.system === 'string' && payload.system.includes('SYS:maid:'), 'A1 system prompt 组装')
    check(Array.isArray(payload.history) && payload.history.length === 2 && payload.history[0].role === 'user', 'A1 history 传递（去掉当前轮）')
    check(payload.pack && payload.pack.id === 'pack.x', 'A1 当前产物 pack 传递')
    check(payload.baseURL === 'https://api.deepseek.com/v1', 'A1 baseURL 回退 cfg')
  }
  // __onAiResult 正常路径
  let processed = null
  sandbox.processAiRaw = (raw, persona, isFirst, inp) => { processed = { raw, persona, isFirst, inp } }
  sandbox.window.__onAiResult('LLM 原文')
  check(processed && processed.raw === 'LLM 原文' && processed.persona === 'maid', 'A1 __onAiResult 正常分发')
}

// A2 页面半失败：全部页面函数缺失（PC15 主断言）
{
  const { sandbox, posted, js } = makeSandbox({}) // 无任何 page 桩
  let threw = null
  try { vm.runInContext(js, vm.createContext(sandbox), { timeout: 5000 }) }
  catch (e) { threw = e }
  check(threw === null, 'A2 组件全缺失时注入不抛错（PC15：旧实现 ReferenceError 级联）')
  // compose 已被替换为守卫版：不抛错、不发请求
  let composeThrew = null
  try { sandbox.compose() } catch (e) { composeThrew = e }
  check(composeThrew === null, 'A2 守卫版 compose 不抛错')
  check(posted.length === 0, 'A2 组件缺失时不发 ai: 请求')
  // 回调路径不抛错
  let cbThrew = null
  try { sandbox.window.__onAiResult('x'); sandbox.window.__onAiError('y') } catch (e) { cbThrew = e }
  check(cbThrew === null, 'A2 __onAiResult/__onAiError 组件缺失不抛错')
  check(typeof sandbox.window.__onAiResult === 'function', 'A2 回调已定义（注入未被中途截断）')
}

// A3 beginTurn 缺失但 compose 存在：回退原 compose
{
  let origCalled = false
  const { sandbox, posted, js } = makeSandbox({
    page: {
      compose: () => { origCalled = true },
      renderAi: () => {},
      refreshConnNote: () => {},
    },
  })
  vm.runInContext(js, vm.createContext(sandbox), { timeout: 5000 })
  sandbox.compose()
  check(origCalled, 'A3 beginTurn 缺失 → 回退原 compose')
  check(posted.length === 0, 'A3 回退路径不发 ai: 请求')
}

// A4 未配置 Key：failAssistTurn 提示、不发请求
{
  let failMsg = null
  const { sandbox, posted, js } = makeSandbox({
    hasShellKey: false,
    page: {
      renderAi: () => {}, refreshConnNote: () => {},
      compose: () => { throw new Error('不应调用') },
      beginTurn: () => {},
      failAssistTurn: (msg) => { failMsg = msg },
      aiSession: { messages: [{ role: 'user', text: 'x' }] },
      aiMessages: [],
    },
  })
  vm.runInContext(js, vm.createContext(sandbox), { timeout: 5000 })
  sandbox.compose()
  check(failMsg !== null && failMsg.includes('未配置 API Key'), 'A4 未配置 Key 提示明确')
  check(posted.length === 0, 'A4 未配置 Key 不发请求')
}

console.log('== B. BuildNativeSelfCheckScript（自检注入守卫回归） ==')

// B1 裸页面（无 state/getChecks/document 元素）：不抛错
{
  const selfCheckJs = fillSelfCheck({})
  const sandbox = {
    document: { readyState: 'complete', getElementById: () => null },
    window: {},
  }
  let threw = null
  try { vm.runInContext(selfCheckJs, vm.createContext(sandbox), { timeout: 5000 }) }
  catch (e) { threw = e }
  check(threw === null, 'B1 裸页面注入不抛错（守卫回归锁定）')
  check(sandbox.window.__nativeSelfCheck !== undefined, 'B1 __nativeSelfCheck 已定义')
}

// B2 getChecks 存在：猴补丁回填真实探测
{
  const selfCheckJs = fillSelfCheck({ node: '20.11.1', pnpm: '9.1.0', webview2: '131.0.2903.86', appVersion: '1.0.4' })
  const sandbox = {
    document: { readyState: 'complete', getElementById: () => null },
    window: {},
    getChecks: () => [
      { name: 'Node.js', val: 'mock', text: '演示', status: 'ok' },
      { name: 'pnpm', val: 'mock', text: '演示', status: 'ok' },
      { name: 'DSH 版本', val: '', text: '', status: 'warn' },
    ],
    renderCurrent: () => {},
  }
  vm.runInContext(selfCheckJs, vm.createContext(sandbox), { timeout: 5000 })
  const rows = sandbox.getChecks()
  const node = rows.find((r) => r.name === 'Node.js')
  const pnpm = rows.find((r) => r.name === 'pnpm')
  check(node && node.val === '20.11.1', 'B2 Node.js 行回填真实探测（mock 被覆盖）')
  check(pnpm && pnpm.val === '9.1.0', 'B2 pnpm 行回填真实探测')
  check(rows.some((r) => r.name === 'WebView2' && r.val === '131.0.2903.86'), 'B2 追加 WebView2 探测行')
  check(rows.some((r) => r.name === '本程序版本' && r.val === '1.0.4'), 'B2 追加本程序版本行')
}

console.log('== qa13 结果：PASS=' + passes + ' FAIL=' + failures + ' ==')
if (failures > 0) process.exit(1)
