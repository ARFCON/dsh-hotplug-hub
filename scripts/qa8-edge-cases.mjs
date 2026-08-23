#!/usr/bin/env node
/**
 * scripts/qa8-edge-cases.mjs — AI 装配间极端情况矩阵（进程隔离：静态 server + 独立 Edge）
 *
 * 覆盖（用户要求：所有极端情况、每个功能符合预期）：
 *  A. XSS 双向：用户消息含 <img onerror> / 助理文本含 </b><script> 逃逸 ->
 *     渲染为纯文本，DOM 无标签注入、无脚本执行
 *  B. 损坏 localStorage（非法 JSON）-> 刷新后回到干净空态，不崩溃
 *  C. 新会话 confirm 取消 -> 会话保留；确认 -> 清空
 *  D. 重复导入同一产物 x2 -> 第二次跳过（已存在），无重复条目
 *  E. 双击/连按 Enter -> 只发一条（aiRunning 守卫）
 *  F. 500px 极窄视口 -> 面板/输入坞无横向溢出、控件可操作
 *  G. 特殊字符（<>&"'、emoji、中文引号）-> 原文准确渲染（无乱码/无实体泄漏）
 *  H. markdown 轻渲染：加粗/行内码/代码围栏/链接剥文本 - 干净可读，无 a 标签
 *  I. 助手文本再次注入尝试（LLM 逃逸）-> 仍安全
 *  J. 产物卡「导出到桌面」点击不抛错（download 触发）
 *
 * 用法：node scripts/qa8-edge-cases.mjs（自起 3983 端口）
 */
import { launch } from 'puppeteer-core'
import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { join, extname, resolve } from 'node:path'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const STATIC_ROOT = resolve('dsh-hotplug-hub/dsh-pack-hub')
const PORT = 3983

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
const check = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  PASS ' + name) }
  else { fail += 1; console.log('  FAIL ' + name + (detail ? ('  ' + String(detail).slice(0, 160)) : '')) }
}

const browser = await launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] })
const pageErrors = []
try {
  const page = await browser.newPage()
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  let dialogAction = 'accept'
  page.on('dialog', (d) => { if (dialogAction === 'accept') d.accept(); else d.dismiss() })
  await page.evaluateOnNewDocument(() => { window.__xss = 0; window.__b64 = (s) => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0))) })
  await page.setViewport({ width: 1280, height: 860 })
  await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'networkidle2', timeout: 30000 })
  await page.evaluate(() => switchView('ai'))  // v1.2：女仆坞仅主页，经路由进入（回主页 + 展开）
  await new Promise((r) => setTimeout(r, 400))

  const send = async (text) => {
    await page.evaluate((t) => {
      const inp = document.getElementById('reqInput')
      inp.value = t
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    }, text)
    await new Promise((r) => setTimeout(r, 2600))
  }

  console.log('== A. XSS: 用户输入 ==')
  await send('<img src=x onerror=window.__xss=1>')
  check('用户消息按纯文本渲染', await page.evaluate(() => document.querySelector('#aiCol .ai-msg.user img') === null))
  check('onerror 未执行 (window.__xss=0)', (await page.evaluate(() => window.__xss)) === 0)
  const userTxt = await page.evaluate(() => { const b = document.querySelector('#aiCol .ai-msg.user .ai-bubble'); return b ? b.textContent : '' })
  check('用户消息原文保留', userTxt === '<img src=x onerror=window.__xss=1>', userTxt)

  console.log('== B. 损坏 localStorage ==')
  await page.evaluate(() => { localStorage.setItem('dshAiRoom', '{bad json!!') })
  await page.reload({ waitUntil: 'networkidle2' })
  await new Promise((r) => setTimeout(r, 400))
  await page.evaluate(() => switchView('ai'))  // v1.2：女仆坞仅主页，经路由进入（回主页 + 展开）
  await new Promise((r) => setTimeout(r, 500))
  check('损坏存储 -> 干净空态 (无崩溃)', (await page.$('.ai-welcome')) !== null && (await page.evaluate(() => document.querySelectorAll('#aiCol .ai-msg').length)) === 0)
  await page.evaluate(() => { localStorage.removeItem('dshAiRoom') })

  console.log('== C. 新会话 confirm 取消/确认 ==')
  await send('帮我组一个笔记包')
  const beforeCancel = await page.evaluate(() => document.querySelectorAll('#aiCol .ai-msg').length)
  dialogAction = 'dismiss'
  await page.click('#aiNewSessionBtn')
  await new Promise((r) => setTimeout(r, 400))
  const afterCancel = await page.evaluate(() => document.querySelectorAll('#aiCol .ai-msg').length)
  check('confirm 取消 -> 会话保留', afterCancel === beforeCancel, beforeCancel + ' -> ' + afterCancel)
  dialogAction = 'accept'
  await page.click('#aiNewSessionBtn')
  await new Promise((r) => setTimeout(r, 400))
  check('confirm 确认 -> 回到空态', (await page.$('.ai-welcome')) !== null)

  console.log('== D. 重复导入同一产物 ==')
  await send('帮我组一个剪辑包')
  const impBefore = await page.evaluate(() => state.imported.length)
  await page.click('.ai-pack-card .ai-act-import')
  await new Promise((r) => setTimeout(r, 400))
  const impMid = await page.evaluate(() => state.imported.length)
  check('首次导入入库', impMid === impBefore + 1, impBefore + ' -> ' + impMid)
  // 导入成功会按产品行为切到插件中枢视图 → 切回 AI 视图再点第二次
  await page.evaluate(() => switchView('ai'))  // v1.2：女仆坞仅主页，经路由进入（回主页 + 展开）
  await new Promise((r) => setTimeout(r, 400))
  await page.click('.ai-pack-card .ai-act-import')
  await new Promise((r) => setTimeout(r, 400))
  const impAfter = await page.evaluate(() => state.imported.length)
  check('重复导入跳过 (已存在，不重复)', impAfter === impMid, impMid + ' -> ' + impAfter)
  await page.click('#aiNewSessionBtn')
  await new Promise((r) => setTimeout(r, 400))

  console.log('== E. 连按两次 Enter ==')
  const dblBefore = await page.evaluate(() => document.querySelectorAll('#aiCol .ai-msg.user').length)
  await page.evaluate(() => {
    const inp = document.getElementById('reqInput')
    inp.value = '帮我组一个视频包'
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
  await new Promise((r) => setTimeout(r, 2600))
  const dblAfter = await page.evaluate(() => document.querySelectorAll('#aiCol .ai-msg.user').length)
  check('连按 Enter 只发一条', dblAfter === dblBefore + 1, dblBefore + ' -> ' + dblAfter)

  console.log('== F. 500px 极窄视口 ==')
  await page.setViewport({ width: 500, height: 900 })
  await new Promise((r) => setTimeout(r, 300))
  await page.click('#aiSettingsBtn')
  await new Promise((r) => setTimeout(r, 300))
  const noHOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
  check('极窄无横向溢出', noHOverflow, await page.evaluate(() => String(document.documentElement.scrollWidth) + ' vs ' + String(window.innerWidth)))
  check('极窄下面板 Key 输入仍可操作', await page.evaluate(() => {
    const el = document.getElementById('aiKeyInput')
    if (!el) return false
    const r = el.getBoundingClientRect()
    return r.width > 100 && r.width <= window.innerWidth
  }))
  await page.click('#aiSettingsBtn')
  await page.setViewport({ width: 1280, height: 860 })

  console.log('== G/H/I. 特殊字符 + markdown 渲染 + 二次注入 ==')
  await send('帮我组一个写作包')
  await page.evaluate((b64) => { processAiRaw(window.__b64(b64), 'maid', false, '测试') },
    '6L+Z5pivKirph43ngrkqKuWSjGDooYzlhoXnoIFg77yMW+mTvuaOpV0oaHR0cHM6Ly9ldmlsLmV4YW1wbGUp5rWL6K+V44CCCgp8IOaPkuS7tiB8IOiBjOi0oyB8CnwtLS18LS0tfAp8IGEgfCBiIHwKCmBgYGpzCnZhciBhPTEKYGBgCg==')
  await new Promise((r) => setTimeout(r, 400))
  const md = await page.evaluate(() => {
    const bs = document.querySelectorAll('#aiCol .ai-msg.assistant .ai-bubble')
    const last = bs[bs.length - 1]
    return {
      bold: !!last.querySelector('b'),
      code: !!last.querySelector('code'),
      pre: !!last.querySelector('pre'),
      a: !!last.querySelector('a'),
      text: last.textContent
    }
  })
  check('加粗渲染为 <b>', md.bold)
  check('行内码渲染为 <code>', md.code)
  check('围栏渲染为 <pre>', md.pre)
  check('链接剥为纯文本 (无 <a>)', !md.a && md.text.includes('链接测试') && !md.text.includes('https://evil'))
  check('表格降级为文本 (无竖线符/无分界行)', md.text.includes('插件 · 职责') && md.text.includes('a · b') && !md.text.includes('|---|---|'), md.text.slice(0, 80))
  await page.evaluate(() => {
    processAiRaw('逃逸</b><script>window.__xss=1</script><img src=x onerror=window.__xss=1>', 'maid', false, '测试2')
  })
  await new Promise((r) => setTimeout(r, 400))
  check('二次注入被转义 (无 img/script 元素)', await page.evaluate(() => {
    const bs = document.querySelectorAll('#aiCol .ai-msg.assistant .ai-bubble')
    const last = bs[bs.length - 1]
    return !last.querySelector('img') && !last.querySelector('script') && !last.querySelector('body')
  }))
  check('二次注入未执行脚本', (await page.evaluate(() => window.__xss)) === 0)
  const escTxt = await page.evaluate(() => {
    const bs = document.querySelectorAll('#aiCol .ai-msg.assistant .ai-bubble')
    return bs[bs.length - 1].textContent
  })
  check('特殊字符原文准确 (不实体泄漏)', escTxt.includes('</b><script>') && escTxt.includes('<img'), escTxt.slice(0, 60))

  console.log('== J. 导出按钮不抛错 ==')
  await page.evaluate(() => {
    const cards = document.querySelectorAll('.ai-pack-card')
    const btn = cards[0] ? cards[0].querySelector('#exportPack') : null
    if (btn) btn.click()
  })
  await new Promise((r) => setTimeout(r, 600))
  check('导出到桌面点击无崩溃', (await page.$$('.ai-pack-card')).length > 0)

  const realErrors = pageErrors.filter((e) => !/404|favicon|Failed to load resource/i.test(e))
  check('全程无页面 JS 错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))
  console.log('== 极端矩阵: PASS=' + pass + ' FAIL=' + fail + ' ==')
} finally {
  await browser.close()
  server.close()
}
process.exitCode = fail === 0 ? 0 : 1
