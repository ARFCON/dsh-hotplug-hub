#!/usr/bin/env node
/**
 * scripts/qa7-exe-channel.mjs — EXE（WebView2）AI 渠道行为模拟验收
 *
 * 做法：从 release/src/Main.cs 的 BuildApiIntegrationScript 中**原样提取**注入 JS，
 * 在全新页面执行（与 EXE 导航后注入一致），window.chrome.webview 用 mock 捕获
 * C# 侧请求（ai: 负载），测试脚本扮演 C# 回传 LLM 原文 / 错误。
 *
 * 覆盖（用户要求：每个功能都能用、逻辑完全正确、极端情况）：
 *   A. 首轮：beginTurn 状态（欢迎卡移除/输入清空/按钮禁用/轮次）→ 请求负载（text/model/
 *      persona/system 组装模式/history/pack）→ LLM 原文回传 → 产物卡 2 插件（非 0！）
 *   B. 二轮修改：请求负载含完整 history + 当前 pack + 对话模式 → 差异徽标；多张产物卡
 *      per-card 数据各自正确（第一张 copy=第一版、第二张 copy=第二版）
 *   C. 错误回传：错误气泡、按钮恢复、typing 消失、不污染上下文
 *   D. 未配置 Key：明确提示「未配置 DSH API」且不向 C# 发请求
 *   E. 刷新（EXE 重新注入）后：会话+产物卡恢复，按钮仍可用（per-card 数据持久化）
 *
 * 用法：node scripts/qa7-exe-channel.mjs（自起 3982 端口静态服务）
 */
import { launch } from 'puppeteer-core'
import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { join, extname, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STATIC_ROOT = join(ROOT, 'dsh-hotplug-hub', 'dsh-pack-hub')
const PORT = 3982

// ---- 从 Main.cs 原样提取 BuildApiIntegrationScript 的 JS ----
const mainCs = readFileSync(join(ROOT, 'release', 'src', 'Main.cs'), 'utf8')
const startMarker = '"window.__apiConfig='
const endMarker = '"})();";'
const sIdx = mainCs.indexOf(startMarker)
const eIdx = mainCs.indexOf(endMarker, sIdx)
if (sIdx < 0 || eIdx < 0) { console.error('FAIL 无法从 Main.cs 提取集成脚本'); process.exit(2) }
const segment = mainCs.slice(sIdx, eIdx + endMarker.length)
const literals = [...segment.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1])
if (literals.some((l) => l.includes('\\'))) { console.error('FAIL 注入脚本含转义字符，需实现 C# 转义还原'); process.exit(2) }
let injectJs = literals.join('')
injectJs = injectJs.replace('window.__apiConfig=', 'window.__apiConfig=') // configJson 占位（非字面量），下方替换
const mockCfg = { apiKey: 'sk-mock', baseUrl: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat', models: [], temperature: 1.0 }
const injectWith = (cfg) => injectJs.replace(/window\.__apiConfig=[^;]*;/, 'window.__apiConfig=' + JSON.stringify(cfg) + ';')

// ---- 静态服务 ----
const server = createServer((req, res) => {
  let f = (req.url || '/').split('?')[0]
  if (f === '/') f = '/prototype.html'
  const p = join(STATIC_ROOT, f)
  if (!existsSync(p)) { res.writeHead(404); res.end('404'); return }
  res.writeHead(200, { 'Content-Type': extname(p) === '.html' ? 'text/html; charset=utf-8' : 'text/plain' })
  res.end(readFileSync(p))
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

let pass = 0
let fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`) }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? '：' + detail : ''}`) }
}

const browser = await launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] })
const pageErrors = []
const newPage = async () => {
  const page = await browser.newPage()
  page.on('dialog', (d) => { void d.accept() })
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('[console] ' + m.text()) })
  await page.evaluateOnNewDocument(() => {
    window.__capturedAi = []
    window.chrome = { webview: { postMessage: (m) => window.__capturedAi.push(String(m)) } }
    try {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: (t) => { window.__copied = t; return Promise.resolve() } }
      })
    } catch (_) { /* 尽力而为 */ }
  })
  return page
}
const gotoAi = async (page) => {
  await page.setViewport({ width: 1280, height: 860 })
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2', timeout: 30000 })
  await page.click('#nav button[data-view="ai"]')
  await new Promise((r) => setTimeout(r, 400))
}
const send = async (page, text) => {
  await page.evaluate((t) => {
    const inp = document.getElementById('reqInput')
    inp.value = t
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  }, text)
  await new Promise((r) => setTimeout(r, 250))
}
const replyRaw = async (page, raw) => {
  await page.evaluate((r) => { window.__onAiResult(r) }, raw)
  await new Promise((r) => setTimeout(r, 400))
}
const HP_A = '```json\n{"hotpack":"1.0","id":"pack.ai.demo","name":"校对助手包","version":"0.1.0","description":"校对","tags":["写作"],"plugins":[{"id":"spell","name":"spellchecker","version":"1.2.3","source":{"type":"npm"},"config":{}},{"id":"format","name":"format-md","version":"2.0.1","source":{"type":"npm"},"config":{}}]}\n```'
const HP_B = '```json\n{"hotpack":"1.0","id":"pack.ai.demo","name":"校对助手包","version":"0.2.0","description":"校对","tags":["写作"],"plugins":[{"id":"spell","name":"spellchecker","version":"1.2.3","source":{"type":"npm"},"config":{}},{"id":"prettier","name":"prettier","version":"3.3.3","source":{"type":"npm"},"config":{}}]}\n```'

try {
  console.log('== A. 首轮 EXE 渠道：组装请求 + LLM 原文回传 ==')
  const page = await newPage()
  await gotoAi(page)
  await page.evaluate(injectWith(mockCfg))
  // 面板（EXE 模式）：外壳行注入 / Key 输入禁用 / 模型端点填充自外壳配置
  await page.click('#aiSettingsBtn')
  await new Promise((r) => setTimeout(r, 300))
  check('EXE 模式外壳行注入（Key 由 DSH 外壳提供）', await page.evaluate(() => {
    const sr = document.getElementById('aiShellRow')
    return !!sr && sr.style.display === 'flex' && sr.textContent.includes('外壳已提供') && !!sr.querySelector('button')
  }))
  check('EXE 模式 Key 输入禁用（防误配）', await page.$eval('#aiKeyInput', (el) => el.disabled))
  check('EXE 模式面板模型/端点填充自外壳配置', await page.evaluate(() => {
    const mi = document.getElementById('aiModelInput')
    const bi = document.getElementById('aiBaseUrlInput')
    return !!mi && mi.value === 'deepseek-chat' && !!bi && bi.value === 'https://api.deepseek.com/v1'
  }))
  await page.click('#aiTestBtn')
  await new Promise((r) => setTimeout(r, 300))
  const testMsg = await page.evaluate(() => window.__capturedAi.find((m) => m.startsWith('aiTest:')) || '')
  check('测试连接经外壳消息（aiTest:）', testMsg.startsWith('aiTest:'), testMsg.slice(0, 44))
  await page.click('#aiSettingsBtn')
  await new Promise((r) => setTimeout(r, 200))
  await send(page, '帮我校对 Word 文档')
  check('用户气泡出现', await page.$eval('#aiCol', (el) => el.textContent.includes('帮我校对 Word 文档')))
  check('打字指示器出现', await page.$('#aiTyping') !== null)
  check('发送按钮运行中禁用', await page.$eval('#composeBtn', (el) => el.disabled))
  check('新会话按钮运行中禁用', await page.$eval('#aiNewSessionBtn', (el) => el.disabled))
  check('欢迎卡已移除（EXE 首发送不残留）', await page.$('.ai-welcome') === null)
  check('输入框已清空', await page.$eval('#reqInput', (el) => el.value) === '')
  const cap1 = JSON.parse((await page.evaluate(() => window.__capturedAi.filter((m) => m.startsWith('ai:'))[0] || '')).slice(3))
  check('请求含 text/model/persona', cap1.text === '帮我校对 Word 文档' && cap1.model === 'deepseek-chat' && cap1.persona === 'maid', JSON.stringify({ text: cap1.text, model: cap1.model }))
  check('请求含组装模式 system', (cap1.system || '').includes('组装模式'), (cap1.system || '').slice(0, 24))
  check('首轮 history 为空', Array.isArray(cap1.history) && cap1.history.length === 0, JSON.stringify(cap1.history))
  check('首轮 pack 为空', cap1.pack === null)
  await replyRaw(page, HP_A)
  check('打字指示器消失', await page.$('#aiTyping') === null)
  check('产物卡出现且非 0 插件', (await page.$eval('.ai-pack-card', (el) => el.textContent))?.includes('2 个插件') === true)
  check('插件行 ×2', (await page.$$('.ai-pack-card .ai-plugins .p')).length === 2)
  check('发送按钮恢复可用', await page.$eval('#composeBtn', (el) => !el.disabled))
  check('新会话按钮恢复可用', await page.$eval('#aiNewSessionBtn', (el) => !el.disabled))
  check('轮次徽标 = 第 1 轮', (await page.$eval('#aiTurnBadge', (el) => el.textContent)) === '第 1 轮')
  check('祝贺语为人设化（主人…请过目～）', (await page.$eval('#aiCol .ai-msg.assistant .ai-bubble', (el) => el.textContent)).includes('请过目～'))

  console.log('== B. 二轮 EXE 渠道：多轮上下文 + 差异 + per-card 数据 ==')
  // 面板改模型 → 发送应使用面板值（模型由面板优先，外壳 defaultModel 兜底）
  await page.evaluate(() => {
    const mi = document.getElementById('aiModelInput')
    mi.value = 'kimi-k3'
    mi.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await send(page, '把 format-md 换成 prettier')
  const cap2 = JSON.parse((await page.evaluate(() => window.__capturedAi.filter((m) => m.startsWith('ai:'))[1] || '')).slice(3))
  check('二轮请求使用面板模型（面板优先）', cap2.model === 'kimi-k3', cap2.model)
  check('二轮 history 含完整上下文（≥2 条）', Array.isArray(cap2.history) && cap2.history.length >= 2, `len=${(cap2.history || []).length}`)
  check('二轮 pack 携带当前清单', cap2.pack && cap2.pack.hotpack === '1.0' && cap2.pack.id === 'pack.ai.demo', JSON.stringify(cap2.pack && cap2.pack.id))
  check('二轮 system 为对话模式', (cap2.system || '').includes('对话模式'))
  await replyRaw(page, HP_B)
  check('第二张产物卡出现', (await page.$$('.ai-pack-card')).length === 2)
  const diffTxt = await page.evaluate(() => {
    const cards = document.querySelectorAll('.ai-pack-card')
    return cards.length ? cards[1].textContent : ''
  })
  check('差异徽标（+新增 1 / -移除 1）', diffTxt.includes('新增 1') && diffTxt.includes('移除 1'), diffTxt.slice(0, 80))
  await page.$$eval('.ai-pack-card #copyManifest', (els) => els[1].click())
  await new Promise((r) => setTimeout(r, 300))
  const copy2 = await page.evaluate(() => window.__copied || '')
  check('第二张卡复制 = 第二版（per-card）', copy2.includes('prettier') && !copy2.includes('format-md'))
  await page.$$eval('.ai-pack-card #copyManifest', (els) => els[0].click())
  await new Promise((r) => setTimeout(r, 300))
  const copy1 = await page.evaluate(() => window.__copied || '')
  check('第一张卡复制 = 第一版（per-card）', copy1.includes('format-md') && !copy1.includes('prettier'))
  check('轮次徽标 = 第 2 轮', (await page.$eval('#aiTurnBadge', (el) => el.textContent)) === '第 2 轮')

  console.log('== C. 错误回传：恢复 + 不污染 ==')
  await send(page, '再调一下版本')
  await replyRaw(page, '这段回复不是 JSON 产物，只是闲聊回复。')
  const rawReplyBubble = await page.evaluate(() => {
    const ms = document.querySelectorAll('#aiCol .ai-msg.assistant .ai-bubble')
    return ms.length ? ms[ms.length - 1].textContent : ''
  })
  check('对话轮无 JSON → 纯文本回显（无产物变更）', rawReplyBubble.includes('闲聊回复'), rawReplyBubble.slice(0, 30))
  await send(page, '再调一下')
  await page.evaluate(() => window.__onAiError('模型炸了'))
  await new Promise((r) => setTimeout(r, 300))
  const errTxt = await page.evaluate(() => {
    const errs = document.querySelectorAll('#aiCol .ai-msg.err .ai-bubble')
    return errs.length ? errs[errs.length - 1].textContent : ''
  })
  check('错误气泡出现且人设化', errTxt.includes('模型炸了'), errTxt)
  check('错误后发送恢复可用', await page.$eval('#composeBtn', (el) => !el.disabled))
  check('错误后 typing 消失', await page.$('#aiTyping') === null)
  const cardCount = (await page.$$('.ai-pack-card')).length
  check('错误不新增产物卡', cardCount === 2, `cards=${cardCount}`)

  console.log('== D. 未配置 Key：明确提示且不发请求 ==')
  const page2 = await newPage()
  await gotoAi(page2)
  await page2.evaluate(injectWith({ ...mockCfg, apiKey: '' }))
  await send(page2, '随便组个包')
  const dErr = await page2.evaluate(() => {
    const errs = document.querySelectorAll('#aiCol .ai-msg.err .ai-bubble')
    return errs.length ? errs[errs.length - 1].textContent : ''
  })
  check('未配置 Key 明确提示（⚙ 模型）', dErr.includes('未配置 DSH API') && dErr.includes('⚙ 模型'), dErr)
  check('未配置 Key 不向 C# 发请求', (await page2.evaluate(() => window.__capturedAi.length)) === 0)
  check('未配置 Key 后发送恢复可用', await page2.$eval('#composeBtn', (el) => !el.disabled))
  await page2.close()

  console.log('== E. 刷新（EXE 重新注入）后恢复与按钮可用 ==')
  await page.reload({ waitUntil: 'networkidle2' })
  await page.click('#nav button[data-view="ai"]')
  await new Promise((r) => setTimeout(r, 500))
  await page.evaluate(injectWith(mockCfg)) // 导航完成后 C# 再注入一次
  const restoredCards = (await page.$$('.ai-pack-card')).length
  check('刷新后产物卡恢复 ×2', restoredCards === 2, `cards=${restoredCards}`)
  const impBefore = await page.evaluate(() => (typeof state !== 'undefined' ? state.imported.length : -1))
  await page.$$eval('.ai-pack-card #importAiPack', (els) => els[0].click())
  await new Promise((r) => setTimeout(r, 300))
  const impAfter = await page.evaluate(() => (typeof state !== 'undefined' ? state.imported.length : -1))
  check('刷新后一键导入仍可用（per-card 持久化）', impAfter === impBefore + 1, `${impBefore} → ${impAfter}`)
  await page.$$eval('.ai-pack-card #copyManifest', (els) => els[0].click())
  await new Promise((r) => setTimeout(r, 300))
  const copyR = await page.evaluate(() => window.__copied || '')
  check('刷新后复制第一张卡 = 第一版', copyR.includes('format-md') && !copyR.includes('prettier'))
  await page.close()

  const realErrors = pageErrors.filter((e) => !/404|favicon|Failed to load resource/i.test(e))
  check('全程无页面 JS 错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))
  console.log(`== EXE 渠道模拟：PASS=${pass} FAIL=${fail} ==`)
} finally {
  await browser.close()
  server.close()
}
process.exitCode = fail === 0 ? 0 : 1
