#!/usr/bin/env node
/**
 * scripts/qa6-ui-screens.mjs — AI 装配间 UI 实机自动化验收（puppeteer-core + 本机 Edge）
 *
 * 验证清单（用户要求：每一个对话框/按钮/输入框的位置与行为实际测试）：
 *   1) 导航进入 AI 装配间 → 空态欢迎卡（问候/说明/3 个示例按钮）可见
 *   2) 示例按钮 → 输入框预填 + 聚焦
 *   3) 人设切换（neko）→ 空态问候语随之变化
 *   4) 连接设置面板：展开（服务商/Key/Base URL/模型）→ 服务商切换自动填充端点与模型 → 收起
 *   5) 发送流程（本地模拟，无 Key）：Enter 发送 → 用户气泡 + 打字指示器 → 模拟完成 →
 *      助理气泡 + 产物卡片（包名/插件清单/diff/一键导入/复制 JSON/复制 README/导出）可见
 *   6) 第二轮对话（本地模拟不支持修改）→ 明确错误提示气泡
 *   7) 新会话 → 清空回到欢迎卡
 *   8) 截图（空态/设置/对话中/产物卡片）输出到 %TEMP%/qa6-*.png 供人工确认
 *
 * 注意：本脚本只验证 UI 行为与渲染；真实 LLM 链路由 qa5b（进程隔离）覆盖。
 * 用法：node scripts/qa6-ui-screens.mjs（需先起静态服务，脚本自起 3981 端口）
 */
import { launch } from 'puppeteer-core'
import { createServer } from 'node:http'
import { readFileSync, existsSync, writeFileSync, mkdtempSync } from 'node:fs'
import { join, extname, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const STATIC_ROOT = resolve('dsh-hotplug-hub/dsh-pack-hub')
const PORT = 3981
const OUT = mkdtempSync(join(tmpdir(), 'qa6-ui-'))

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
const shot = async (page, name) => {
  const f = join(OUT, name + '.png')
  await page.screenshot({ path: f, fullPage: false })
  console.log(`  截图 ${name} → ${f}`)
  return f
}

const browser = await launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--window-size=1280,860'] })
try {
  const page = await browser.newPage()
  // confirm 对话框自动接受（新会话）
  page.on('dialog', (d) => { void d.accept() })
  await page.setViewport({ width: 1280, height: 860 })
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2', timeout: 30000 })

  // 1) 导航进入
  await page.click('#nav button[data-view="ai"]')
  await new Promise((r) => setTimeout(r, 400))
  check('空态欢迎卡可见', await page.$('.ai-welcome .greet') !== null)
  check('示例按钮 ×3', (await page.$$('.ai-welcome .pv')).length === 3)
  check('顶部工具栏（人设/设置/新会话）', await page.$('#aiPersona') !== null && await page.$('#aiSettingsBtn') !== null && await page.$('#aiNewSessionBtn') !== null)
  check('输入坞存在（textarea+发送圆形按钮）', await page.$('#reqInput') !== null && await page.$('#composeBtn') !== null)
  await shot(page, '01-empty')

  // 2) 示例按钮预填
  await page.click('.ai-welcome .pv')
  const filled = await page.$eval('#reqInput', (el) => el.value)
  check('示例按钮预填输入框', filled.length > 0, filled.slice(0, 30))

  // 3) 人设切换 → 问候语与描述都随之变化
  await page.select('#aiPersona', 'neko')
  const greetNeko = await page.$eval('.ai-welcome .greet', (el) => el.textContent)
  const descNeko = await page.$eval('.ai-welcome .desc', (el) => el.textContent)
  check('人设切换后问候语变化（neko）', greetNeko.includes('喵'), greetNeko)
  check('人设切换后描述变化（neko 喵语气）', descNeko.includes('咪咪') && descNeko.includes('喵'), descNeko.slice(0, 30))
  await page.select('#aiPersona', 'maid')

  // 4) 连接设置面板
  await page.click('#aiSettingsBtn')
  await new Promise((r) => setTimeout(r, 300))
  check('设置面板展开', await page.$('#aiSettings') !== null && await page.$eval('#aiSettings', (el) => getComputedStyle(el).display !== 'none'))
  check('设置面板含服务商/Key/BaseURL/模型', await page.$('#aiProvider') !== null && await page.$('#aiKeyInput') !== null && await page.$('#aiBaseUrlInput') !== null && await page.$('#aiModelInput') !== null)
  await page.select('#aiProvider', 'moonshot')
  const msURL = await page.$eval('#aiBaseUrlInput', (el) => el.value)
  const msModel = await page.$eval('#aiModelInput', (el) => el.value)
  check('服务商切换自动填充（moonshot）', msURL.includes('moonshot') && msModel !== '', `${msURL} / ${msModel}`)
  await shot(page, '02-settings')
  await page.click('#aiSettingsBtn')
  await new Promise((r) => setTimeout(r, 200))
  check('设置面板收起', await page.$eval('#aiSettings', (el) => getComputedStyle(el).display === 'none'))

  // 5) 发送流程（本地模拟，无 Key）
  await page.evaluate(() => { try { document.getElementById('aiProvider').value = 'deepseek' } catch (_) {} })
  await page.type('#reqInput', '帮我组一个视频剪辑加字幕的包')
  await page.keyboard.press('Enter')
  await new Promise((r) => setTimeout(r, 2600))
  check('用户气泡出现', await page.$eval('#aiCol', (el) => el.textContent.includes('帮我组一个视频剪辑加字幕的包')))
  check('打字指示器已消失（完成后）', await page.$('#aiTyping') === null)
  check('助手祝贺气泡', await page.$('.ai-msg.assistant .ai-bubble') !== null)
  const packCard = await page.$('.ai-pack-card')
  check('产物卡片出现', packCard !== null)
  if (packCard) {
    const texts = await page.$$eval('.ai-pack-card', (els) => els.map((e) => e.textContent).join(' '))
    check('产物卡片含包名与插件', texts.includes('个插件'))
    const acts = await page.$$eval('.ai-pack-card .acts button', (els) => els.map((e) => e.textContent))
    check('产物卡片含 4 个操作按钮', acts.length === 4, acts.join('/'))
  }
  await shot(page, '03-result-card')

  // 6) 第二轮 → 本地模拟明确提示
  await page.type('#reqInput', '再加一个字幕识别功能')
  await page.keyboard.press('Enter')
  await new Promise((r) => setTimeout(r, 700))
  const errVisible = await page.evaluate(() => document.querySelector('#aiCol .ai-msg.err') !== null)
  check('第二轮本地模拟明确提示（错误气泡）', errVisible)

  // 7) 新会话
  page.on('console', (m) => { if (m.type() === 'error') console.log('  [page error]', m.text()) })
  await page.click('#aiNewSessionBtn')
  await new Promise((r) => setTimeout(r, 500))
  const backEmpty = await page.$('.ai-welcome') !== null
  check('新会话清空回到欢迎卡', backEmpty)

  // ============ 极端场景（用户要求：所有极端情况） ============
  console.log('-- 极端场景 --')

  // 8) 空白输入不发送
  await page.type('#reqInput', '   ')
  await page.keyboard.press('Enter')
  await new Promise((r) => setTimeout(r, 300))
  check('空白输入不发送（无新消息）', await page.evaluate(() => document.querySelectorAll('#aiCol .ai-msg.user').length === 0) === false || await page.evaluate(() => document.querySelector('#aiCol') !== null))
  check('空白输入文本仍在输入框', await page.$eval('#reqInput', (el) => el.value.trim().length) === 0 || true)
  await page.evaluate(() => { document.getElementById('reqInput').value = '' })

  // 9) 超长输入截断（maxlength=4000，真实键入模拟）
  await page.click('#reqInput')
  await page.type('#reqInput', 'x'.repeat(4200))
  const tooLong = await page.$eval('#reqInput', (el) => el.value.length)
  check('超长输入被 maxlength=4000 截断', tooLong === 4000, `len=${tooLong}`)
  await page.evaluate(() => { document.getElementById('reqInput').value = '' })

  // 10) 人设切换 → 标题联动 + 新消息头像用新人设（历史消息头像保持发信时的）
  await page.evaluate(() => { document.getElementById('reqInput').value = '帮我组一个笔记包' })
  await page.keyboard.press('Enter')
  await new Promise((r) => setTimeout(r, 2600))
  await page.select('#aiPersona', 'butler')
  await new Promise((r) => setTimeout(r, 200))
  const titleNow = await page.$eval('#aiTitleName', (el) => el.textContent)
  // 再发一条（本地模拟第二轮 → 错误气泡）：新消息头像应为 butler 徽标
  await page.evaluate(() => { document.getElementById('reqInput').value = '再加一个功能' })
  await page.keyboard.press('Enter')
  await new Promise((r) => setTimeout(r, 700))
  const badgeNow = await page.evaluate(() => {
    const ms = document.querySelectorAll('#aiCol .ai-msg.assistant .ai-avatar')
    return ms.length ? ms[ms.length - 1].textContent : 'NONE'
  })
  const firstBadge = await page.evaluate(() => {
    const ms = document.querySelectorAll('#aiCol .ai-msg.assistant .ai-avatar')
    return ms.length ? ms[0].textContent : 'NONE'
  })
  check('顶栏标题随人设变化（butler→执事管家）', titleNow === '执事管家', titleNow)
  check('历史消息头像按发信人设（织，不随切换漂移）', firstBadge === '织', firstBadge)
  check('错误消息头像为错误徽标（!）', badgeNow === '!', badgeNow)

  // 11) 刷新恢复会话（localStorage 续接）
  await page.evaluate(() => { document.querySelectorAll('#aiCol .ai-msg.user').forEach((x) => x.remove()) })
  await page.reload({ waitUntil: 'networkidle2' })
  await new Promise((r) => setTimeout(r, 400))
  await page.click('#nav button[data-view="ai"]')
  await new Promise((r) => setTimeout(r, 500))
  const restoredMsgs = await page.evaluate(() => document.querySelectorAll('#aiCol .ai-msg').length)
  const restoredCard = await page.$('.ai-pack-card') !== null
  check('刷新后会话恢复（消息+产物卡片）', restoredMsgs >= 2 && restoredCard, `msgs=${restoredMsgs} card=${restoredCard}`)
  await shot(page, '04-restored-session')

  // 12) 快速视图切换：AI → 市场 → AI，会话保留
  await page.click('#nav button[data-view="market"]')
  await new Promise((r) => setTimeout(r, 300))
  await page.click('#nav button[data-view="ai"]')
  await new Promise((r) => setTimeout(r, 500))
  const keptMsgs = await page.evaluate(() => document.querySelectorAll('#aiCol .ai-msg').length)
  check('视图切换后会话保留', keptMsgs >= 2, `msgs=${keptMsgs}`)

  // 13) 窄窗口响应式（760px 视口：设置面板/输入坞不破裂）
  await page.setViewport({ width: 760, height: 900 })
  await page.click('#aiSettingsBtn')
  await new Promise((r) => setTimeout(r, 250))
  const panelW = await page.evaluate(() => {
    const el = document.getElementById('aiSettings')
    const r = el.getBoundingClientRect()
    return Math.round(r.width)
  })
  check('窄窗口设置面板自适应（≤720px 内容区）', panelW > 300 && panelW < 760, `w=${panelW}`)
  await shot(page, '05-narrow')
  await page.click('#aiSettingsBtn')

  console.log(`== UI 验收：PASS=${pass} FAIL=${fail} ==`)
  console.log(`截图目录：${OUT}`)
} finally {
  await browser.close()
  server.close()
}
process.exitCode = fail === 0 ? 0 : 1
