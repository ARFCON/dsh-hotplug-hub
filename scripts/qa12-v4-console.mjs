#!/usr/bin/env node
/**
 * scripts/qa12-v4-console.mjs — v4 一体化总控台大面板回归验收（puppeteer-core + 本机 Edge）
 *
 * 本套件是 v4 审计修复的浏览器级回归网，每节都对应一个已实测证明的缺陷根因：
 *   A. 产物卡事件委托存活性 —— 委托挂静态 #view-home，renderHome 任意重建后按钮仍有效
 *      （回归：切视图回家/插件回推重绘后导入、复制全部失效）
 *   B. AI 常驻舱可达性 —— 舱体 sticky 吸顶于视图标题条之下：点击示例芯片 focus(输入框)
 *      不再带动页面滚动，工具栏（人设/设置/新会话）永远可点（回归：工具栏被吸顶头埋没）
 *   C. 响应式堆叠 —— ≤720px 总控台纵向堆叠、无横向溢出、设置面板 Key 输入可操作
 *      （回归：.pcl-home 死规则导致窄屏不堆叠）
 *   D. 主页标题对齐 —— 标题与大面板左缘对齐（桌面 44px / 窄屏 28px）
 *   E. 主题契约 —— 深色主题绿色强调、主题切换不重建 AI 舱（草稿保留）、切换后委托仍活
 *   F. 旧状态迁移 —— 残留 ai 视图/maidDockOpen 的旧会话 → 落主页 + 死键清理
 *   G. 主页服务操作 postMessage 契约 —— 启动/修复/选择客户端/关闭/API 配置五键真实发消息
 *   H. 重绘连续性 —— 切走回来输入草稿与聊天滚动位置保留
 *
 * 进程隔离：独立端口 3998、独立截图临时目录、独立 Edge 实例，可与 qa6-qa11 并行。
 * 用法：node scripts/qa12-v4-console.mjs
 */
import { launch } from 'puppeteer-core'
import { createServer } from 'node:http'
import { readFileSync, existsSync, mkdtempSync } from 'node:fs'
import { join, extname, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STATIC_ROOT = join(ROOT, 'dsh-hotplug-hub', 'dsh-pack-hub')
const PORT = 3998
const OUT = mkdtempSync(join(tmpdir(), 'qa12-v4-'))

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
}

const browser = await launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--window-size=1280,860'] })
try {
  const page = await browser.newPage()
  page.on('dialog', (d) => { void d.accept() })
  page.on('pageerror', (e) => { console.log('  [pageexception]', String(e && e.message || e)); fail += 1 })
  await page.setViewport({ width: 1280, height: 860 })
  // 模拟 EXE 通道：捕获页面 postMessage（主页服务操作五键契约）+ 剪贴板垫片
  await page.evaluateOnNewDocument(() => {
    window.__sent = []
    window.chrome = { webview: { postMessage: (m) => { window.__sent.push(String(m)) } } }
    try {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: (t) => { window.__copied = t; return Promise.resolve() } },
      })
    } catch (_) { /* 尽力而为 */ }
  })
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2', timeout: 30000 })
  const ev = (fn, ...args) => page.evaluate(fn, ...args)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  // 确定性等待：本地模拟轮 = 5×420ms 页面定时器链（≈2.1s）+ 渲染，固定睡眠在慢机/高载下会
  // 间歇性截断——统一用有界轮询（默认 8s 上限），等待条件本身即产物契约
  const waitFor = (fnExpr, timeout = 8000) => page.waitForFunction(fnExpr, { timeout, polling: 250 })
  // 命中测试：元素中心点 elementFromPoint 必须落在目标上（selector 经参数传入页面侧）
  const hitTest = (sel) => page.evaluate((s) => {
    const b = document.querySelector(s)
    if (!b) return null
    const r = b.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return false
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    return !!hit && (hit === b || (hit.closest && hit.closest(s) === b))
  }, sel)

  console.log('== A. 产物卡事件委托存活性（回归：重绘后导入/复制失效） ==')
  await ev(() => switchView('home')); await sleep(300)
  await page.type('#reqInput', '帮我组一个视频剪辑加字幕的包')
  await page.keyboard.press('Enter')
  await waitFor(() => document.querySelectorAll('.ai-pack-card').length === 1)
  await sleep(250)
  check('本地模拟一轮 → 产物卡出现', await ev(() => document.querySelectorAll('.ai-pack-card').length) === 1)
  await ev(() => switchView('market')); await sleep(250)
  await ev(() => switchView('home')); await sleep(300) // renderHome 重建 #homeAiPanel
  check('切走回来 → 产物卡仍在（重渲染自状态）', await ev(() => document.querySelectorAll('.ai-pack-card').length) === 1)
  await page.click('.ai-pack-card .ai-act-copy-manifest'); await sleep(250)
  check('重绘后复制 manifest 仍有效（委托挂在静态 view-home）', await ev(() => (window.__copied || '').includes('packId') && (window.__copied || '').includes('bundles')), String(await ev(() => (window.__copied || '').slice(0, 40))))
  const impBefore = await ev(() => state.imported.length)
  await page.click('.ai-pack-card .ai-act-import'); await sleep(350)
  check('重绘后一键导入真实入库', await ev((b) => state.imported.length) === impBefore + 1, `${impBefore} → ${String(await ev(() => state.imported.length))}`)
  await shot(page, '01-delegation')
  // 二次重绘（导入后 renderAll + switchView('hub') 已切走）再回来验证一次
  await ev(() => switchView('home')); await sleep(300)
  await page.click('.ai-pack-card .ai-act-copy-readme'); await sleep(250)
  check('二次重绘后复制 README 仍有效', await ev(() => (window.__copied || '').startsWith('# ')), String(await ev(() => (window.__copied || '').slice(0, 30))))

  console.log('== B. AI 常驻舱可达性（回归：工具栏被吸顶头埋没） ==')
  await ev(() => { if (!confirm('新会话')) return; aiSession = null; aiMessages = []; aiResult = null; aiClearRoom(); renderAi() }); await sleep(300)
  check('新会话 → 回到欢迎卡（切走回来后新会话按钮仍可点）', await ev(() => document.querySelector('.ai-welcome') !== null))
  await page.click('.ai-welcome .pv'); await sleep(250) // 触发 focus(输入框) —— 修复前这一步会把工具栏埋进吸顶头
  check('点示例芯片后页面未被 focus 带动滚动（舱内自滚）', await ev(() => window.scrollY < 2), `scrollY=${String(await ev(() => Math.round(window.scrollY)))}`)
  check('设置按钮可命中（无遮挡）', await hitTest('#aiSettingsBtn') === true)
  check('新会话按钮可命中（无遮挡）', await hitTest('#aiNewSessionBtn') === true)
  check('人设下拉可命中（无遮挡）', await hitTest('#aiPersona') === true)
  await page.click('#aiSettingsBtn'); await sleep(250)
  check('点击设置 → 面板展开', await ev(() => getComputedStyle(document.getElementById('aiSettings')).display !== 'none'))
  check('设置面板 Key 输入可命中', await hitTest('#aiKeyInput') === true)
  await page.click('#aiSettingsBtn'); await sleep(200) // 收起
  // sticky：矮视口强制页面可滚，滚动后舱体钉在吸顶区（期望值按同一 CSS calc 在页面内解析，
  // 不硬编码像素——主题可调 --nav-h；滚到含块底边时可上滑让位，属标准 sticky 约束行为，
  // 功能性契约是：工具栏不被吸顶头遮挡、始终可点）
  await page.setViewport({ width: 1280, height: 700 })
  await sleep(200)
  await ev(() => window.scrollTo(0, 100000)); await sleep(400)
  const stickyGeo = await ev(() => {
    const cs = getComputedStyle(document.documentElement)
    const num = (v) => parseFloat(cs.getPropertyValue(v)) || 0
    return {
      colTop: Math.round(document.querySelector('.home-ai-col').getBoundingClientRect().top),
      expectedTop: Math.round(num('--nav-h') + num('--menu-h') + 71 + 22),
      topbarBottom: Math.round(document.querySelector('.topbar').getBoundingClientRect().bottom),
      settingsTop: Math.round(document.getElementById('aiSettingsBtn').getBoundingClientRect().top),
    }
  })
  // 判别性契约：舱顶不得低于粘附线+容差（更低=sticky 未生效）；滚到含块底边时可上滑让位
  // （150<191 属标准 sticky 约束，功能上工具栏仍全程可点）；sticky 失效时舱会被页面带走（colTop 为负）
  check('滚动后 AI 舱钉在吸顶区（sticky 生效，未被页面带走）', stickyGeo.colTop > 0 && stickyGeo.colTop <= stickyGeo.expectedTop + 15, JSON.stringify(stickyGeo))
  check('滚动后工具栏在吸顶头之下（不被遮挡）', stickyGeo.settingsTop >= stickyGeo.topbarBottom - 1, JSON.stringify(stickyGeo))
  check('滚动后设置按钮仍可命中', await hitTest('#aiSettingsBtn') === true)
  await page.click('#aiSettingsBtn'); await sleep(250)
  check('滚动后设置点击仍生效（面板展开）', await ev(() => getComputedStyle(document.getElementById('aiSettings')).display !== 'none'))
  await page.click('#aiSettingsBtn'); await sleep(150)
  await shot(page, '02-sticky-scrolled')
  await page.setViewport({ width: 1280, height: 860 }); await sleep(200)
  await ev(() => window.scrollTo(0, 0)); await sleep(250)

  console.log('== C. 响应式堆叠（回归：.pcl-home 死规则致窄屏不堆叠） ==')
  const colCount = () => ev(() => getComputedStyle(document.querySelector('.home-console')).gridTemplateColumns.split(' ').length)
  check('1280 宽 → 总控台双列', await colCount() === 2)
  await page.setViewport({ width: 720, height: 860 }); await sleep(250)
  check('720 宽 → 总控台纵向堆叠（单列）', await colCount() === 1, `cols=${String(await colCount())}`)
  check('720 宽 → 无横向溢出', await ev(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
  await page.setViewport({ width: 500, height: 860 }); await sleep(250)
  check('500 宽 → 总控台纵向堆叠（单列）', await colCount() === 1, `cols=${String(await colCount())}`)
  check('500 宽 → 无横向溢出', await ev(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
  await page.click('#aiSettingsBtn'); await sleep(250)
  check('500 宽 → 设置面板 Key 输入可命中可操作（回归 qa8）', await hitTest('#aiKeyInput') === true)
  await page.click('#aiKeyInput'); await sleep(120)
  await page.type('#aiKeyInput', 'k'); await sleep(120)
  check('500 宽 → Key 输入框真实接收键入', await ev(() => document.getElementById('aiKeyInput').value === 'k'))
  await page.click('#aiSettingsBtn'); await sleep(150)
  await page.setViewport({ width: 1280, height: 860 }); await sleep(250)
  check('恢复 1280 → 双列恢复', await colCount() === 2)
  await shot(page, '03-responsive')

  console.log('== D. 主页标题与大面板左缘对齐（回归：v4 删让位规则） ==')
  const alignOf = () => ev(() => {
    const h = document.querySelector('.topbar h1')
    const shell = document.querySelector('.home-shell')
    const cs = getComputedStyle(shell)
    return { title: Math.round(h.getBoundingClientRect().left), shellL: Math.round(shell.getBoundingClientRect().left + parseFloat(cs.paddingLeft)) }
  })
  let al = await alignOf()
  check('1280 宽：标题与大面板左缘对齐（44px）', al.title === al.shellL, JSON.stringify(al))
  await page.setViewport({ width: 720, height: 860 }); await sleep(250)
  al = await alignOf()
  check('720 宽：标题与大面板左缘对齐（28px）', al.title === al.shellL, JSON.stringify(al))
  await page.setViewport({ width: 1280, height: 860 }); await sleep(250)

  console.log('== E. 主题契约（绿色强调体系 + 切换不重建 AI 舱） ==')
  // 先重建一轮会话（B 节新会话已清空），供本节末尾的产物卡委托复验。
  // 注意：C 节在 Key 输入框键入过 'k'（会话内存 aiKeyMem='k'），不清空会让本轮走真实
  // LLM 路径（401 错误气泡、无产物卡）——必须带 input 事件清回本地模拟模式
  await ev(() => {
    const el = document.getElementById('aiKeyInput')
    if (el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })) }
  })
  await page.click('#reqInput'); await page.type('#reqInput', '帮我组一个考研背诵包')
  await page.keyboard.press('Enter')
  await waitFor(() => document.querySelectorAll('.ai-pack-card').length === 1)
  await sleep(250)
  check('E 节播种：重建一轮 → 产物卡出现', await ev(() => document.querySelectorAll('.ai-pack-card').length) === 1)
  await ev(() => { document.getElementById('reqInput').value = '' })
  const teal = () => ev(() => getComputedStyle(document.documentElement).getPropertyValue('--teal').trim())
  check('默认主题强调色为 PCL 草绿 #43a047', await teal() === '#43a047', await teal())
  await page.evaluate(() => { document.getElementById('reqInput').value = '主题切换前的草稿' })
  await ev(() => switchView('theme')); await sleep(300)
  await page.click('.skin-card[data-skin="dark"]'); await sleep(300)
  check('深色主题 --teal 为绿色 #4caf50（同步 PCL 化，非旧蓝）', await teal() === '#4caf50', await teal())
  check('深色主题无残留硬编码蓝 #2563eb', await ev(() => {
    const t = getComputedStyle(document.documentElement).getPropertyValue('--teal').trim()
    const l = getComputedStyle(document.documentElement).getPropertyValue('--launch').trim()
    return t !== '#2563eb' && l !== '#2563eb'
  }))
  check('启动键渐变底走 --launch 变量（非静态色）', await ev(() => {
    const bg = getComputedStyle(document.getElementById('homeLaunchBtn')).backgroundImage
    return bg.includes('gradient') && !bg.includes('#2563eb') && !bg.includes('rgb(37, 99, 235)')
  }))
  await ev(() => switchView('home')); await sleep(300)
  check('主题切换后 AI 舱仍在左栏且输入草稿保留（切换不重建主页）', await ev(() =>
    document.querySelector('#homeAiPanel .ai-zone') !== null && document.getElementById('reqInput').value === '主题切换前的草稿'))
  await page.click('.ai-pack-card .ai-act-copy-manifest'); await sleep(250)
  check('主题切换后产物卡按钮仍有效（委托存活）', await ev(() => (window.__copied || '').includes('packId')))
  await ev(() => switchView('theme')); await sleep(250)
  await page.click('.skin-card[data-skin="default"]'); await sleep(300)
  check('切回默认主题 → #43a047 恢复', await teal() === '#43a047', await teal())
  await shot(page, '04-theme')

  console.log('== F. 旧状态迁移（回归：ai 视图残留 / maidDockOpen 死键） ==')
  await page.evaluate(() => {
    localStorage.setItem('dsh-pack-hub-prototype', JSON.stringify({ currentView: 'ai', maidDockOpen: true }))
  })
  await page.reload({ waitUntil: 'networkidle2' }); await sleep(500)
  check('旧会话残留 ai 视图 → 刷新后落主页', await ev(() => !document.getElementById('view-home').classList.contains('hidden')))
  check('残留 maidDockOpen 死键已被迁移清理（内存 state）', await ev(() => typeof state.maidDockOpen === 'undefined'))
  await ev(() => switchView('hub')); await sleep(250) // 触发一次 save() → 清理落盘
  check('迁移清理已持久化（save 后 localStorage 无死键）', await ev(() => {
    const s = JSON.parse(localStorage.getItem('dsh-pack-hub-prototype') || '{}')
    return !('maidDockOpen' in s)
  }))
  await ev(() => switchView('home')); await sleep(250)
  check('迁移后主页 AI 舱正常渲染', await ev(() => document.querySelector('#homeAiPanel .ai-zone') !== null))

  console.log('== G. 主页服务操作 postMessage 契约（v4 五键，EXE 通道） ==')
  await ev(() => switchView('home')); await sleep(300)
  await ev(() => { window.__sent = [] })
  await page.click('#homeLaunchBtn'); await sleep(150)
  await page.click('#homeRepairBtn'); await sleep(150)
  await page.click('#homeChooseBtn'); await sleep(150)
  await page.click('#homeHarnessStopBtn'); await sleep(150)
  await page.click('#homeApiBtn'); await sleep(150)
  const sent = await ev(() => window.__sent.slice())
  check('启动键 → launch 消息', sent.includes('launch'), JSON.stringify(sent))
  check('修改配置 → repairConfig 消息', sent.includes('repairConfig'))
  check('选择客户端 → chooseHarness 消息', sent.includes('chooseHarness'))
  check('关闭 DSH → harnessStop 消息', sent.includes('harnessStop'))
  check('API 配置 → openApiConfig 消息', sent.includes('openApiConfig'))
  // 锁步契约：主页服务操作键当前恰为 5 个——新增/删减主页服务键时需同步本断言
  check('五键恰好发五条（无重复绑定/无误发）', sent.length === 5, `n=${String(sent.length)}`)
  await shot(page, '05-console')

  console.log('== H. 重绘连续性：草稿与滚动位置 ==')
  await page.click('#reqInput'); await page.type('#reqInput', '切走前正在输入的内容')
  await ev(() => switchView('hub')); await sleep(250)
  await ev(() => switchView('home')); await sleep(300)
  check('切走回来 → 输入草稿保留（renderHome 销毁前快照）', await ev(() => document.getElementById('reqInput').value === '切走前正在输入的内容'))
  // 同视图重绘（用户正打字的真实场景：外壳插件数据回推触发 renderHome）草稿与聚焦都保留
  await page.click('#reqInput'); await page.type('#reqInput', '，继续补充')
  await ev(() => window.__onPluginsData()); await sleep(300) // 模拟 __setPlugins 回推 → 同视图重绘
  const sameView = await ev(() => ({
    draft: document.getElementById('reqInput').value,
    focused: document.activeElement && document.activeElement.id,
  }))
  check('同视图重绘（插件回推）→ 草稿保留', sameView.draft === '切走前正在输入的内容，继续补充', JSON.stringify(sameView))
  check('同视图重绘（插件回推）→ 聚焦保留', sameView.focused === 'reqInput', JSON.stringify(sameView))

  console.log(`== v4 总控台回归：PASS=${pass} FAIL=${fail} ==`)
  console.log(`截图目录：${OUT}`)
} finally {
  await browser.close()
  server.close()
}
process.exitCode = fail === 0 ? 0 : 1
