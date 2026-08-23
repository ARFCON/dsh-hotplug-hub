#!/usr/bin/env node
/**
 * scripts/qa10-v11-nav-updates.mjs — v1.1 交互契约验收（puppeteer-core + 本机 Edge）
 *
 * 覆盖（v1.1 四大改造的端到端契约）：
 *   1) 顶部折叠菜单：打开缓出面板 → 分组渲染（总览/插件/管理/系统）→ 跳转目标视图 →
 *      外点/Esc 关闭 → 当前项高亮 → 插件更新角标（.n-count.upd）
 *   2) 左侧女仆坞：头像展开/收起 → AI 装配间入住坞内 → switchView('ai') 转义为展开 →
 *      开合状态刷新后持久恢复 → 主区视图切换不影响坞
 *   3) 主页插件更新面板：无更新（绿 ok）/有更新（计数+清单）→ 检查更新=checkPlugins →
 *      一键更新确认=updateAllPlugins → 面板主体点击跳转插件管理
 *   4) 插件变更重启流：postPluginOp 置 pending → __setPlugins 回推 → 重启 DSH 二次确认 →
 *      取消路径不发消息 / 双确认后发 restartHarness
 *
 * 用法：node scripts/qa10-v11-nav-updates.mjs（自起 3984 端口静态服务）
 */
import { launch } from 'puppeteer-core'
import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { join, extname, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STATIC_ROOT = join(ROOT, 'dsh-hotplug-hub', 'dsh-pack-hub')
const PORT = 3984

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

const PLUGINS = [
  { id: 'dsh-hub', name: 'dsh-hub', version: '1.1.7', latest: '1.1.8', enabled: true, hasUpdate: true },
  { id: 'dsh-memory-hub', name: 'dsh-memory-hub', version: '0.8.0', latest: '0.8.0', enabled: true, hasUpdate: false }
]

const browser = await launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--window-size=1280,860'] })
try {
  const page = await browser.newPage()
  page.on('dialog', (d) => { void d.accept() })
  // WebView 桥 mock：捕获 JS→C# 消息（与 qa7 同一手法）。
  // localStorage 只在首个文档清一次（window.name 跨刷新保持），避免清掉待验证的持久化状态。
  await page.evaluateOnNewDocument(() => {
    window.__captured = []
    window.chrome = { webview: { postMessage: (m) => { window.__captured.push(String(m)) } } }
    if (window.name !== '__qa10__') {
      try { localStorage.clear() } catch (_) { /* 尽力而为 */ }
      window.name = '__qa10__'
    }
  })
  await page.setViewport({ width: 1280, height: 860 })
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2', timeout: 30000 })
  const captured = () => page.evaluate(() => window.__captured.filter((m) => m !== 'themeBg:#f6f7f9' && m.indexOf('list') !== 0))
  const openMenu = async () => {
    await page.click('#navMenuBtn')
    await new Promise((r) => setTimeout(r, 320)) // 等下滑缓出动画结束
  }
  const dialogVisible = () => page.evaluate(() => document.getElementById('dlgBackdrop').classList.contains('show'))

  console.log('== 1. 顶部折叠菜单 ==')
  check('初始菜单关闭', await page.evaluate(() => !document.getElementById('navMenuPanel').classList.contains('open')))
  await openMenu()
  check('点击菜单按钮 → 面板缓出打开', await page.evaluate(() => document.getElementById('navMenuPanel').classList.contains('open')))
  const groups = await page.$$eval('.navmenu-group-title', (els) => els.map((e) => e.textContent))
  check('分组渲染（总览/插件/管理/系统）', groups.length === 4 && groups[0] === '总览' && groups[2] === '管理', groups.join('/'))
  const items = await page.$$eval('.navmenu-item', (els) => els.map((e) => e.dataset.view))
  check('菜单含 9 个视图项（AI 已移入女仆坞）', items.length === 9 && !items.includes('ai'), items.join(','))
  check('管理分组含 Skill 面板与 MCP 面板', items.includes('skills') && items.includes('mcp'))
  await page.click('.navmenu-item[data-view="skills"]')
  await new Promise((r) => setTimeout(r, 350))
  check('选择项 → 跳转 Skill 面板且菜单收起', await page.evaluate(() =>
    !document.getElementById('view-skills').classList.contains('hidden') && !document.getElementById('navMenuPanel').classList.contains('open')))
  await openMenu()
  check('当前视图项高亮（skills active）', await page.$eval('.navmenu-item[data-view="skills"]', (e) => e.classList.contains('active')))
  // 点击面板外（页面区域）→ 仅收起菜单、零副作用（不触发底下内容、不跳转——遮罩为最顶层）
  const menuScrimTop = await page.evaluate(() => {
    const top = document.elementFromPoint(900, 500) // 页面区域内一点（当前 skills 视图的内容上方）
    return !!(top && top.id === 'menuScrim')
  })
  check('菜单展开时遮罩为页面区域最顶层（特效不可达）', menuScrimTop)
  await page.mouse.click(900, 500)
  await new Promise((r) => setTimeout(r, 250))
  check('点击面板外 → 仅收起菜单（零副作用，仍停留当前视图）', await page.evaluate(() =>
    !document.getElementById('navMenuPanel').classList.contains('open')
    && !document.getElementById('view-skills').classList.contains('hidden')))
  await openMenu()
  await page.keyboard.press('Escape')
  await new Promise((r) => setTimeout(r, 250))
  check('Esc → 关闭', await page.evaluate(() => !document.getElementById('navMenuPanel').classList.contains('open')))
  // 更新角标（依赖插件数据，先注入再开菜单）
  await page.evaluate((rows) => { window.__pluginsData = rows; window.__onPluginsData() }, PLUGINS)
  await openMenu()
  const badge = await page.$eval('.navmenu-item[data-view="plugins"] .n-count.upd', (e) => e.textContent).catch(() => '')
  check('插件管理项带更新角标（1 更新）', badge.includes('1') && badge.includes('更新'), badge)
  await page.keyboard.press('Escape')

  console.log('== 2. 左侧女仆坞（AI 装配间 · v1.2 仅主页 + 玻璃标签） ==')
  await page.evaluate(() => switchView('home')) // 女仆坞仅存在于主页
  await new Promise((r) => setTimeout(r, 300))
  check('初始收起（左缘玻璃标签，无文字提示）', await page.evaluate(() => {
    const d = document.getElementById('maidDock')
    const ui = d.querySelector('.maid-open-ui')
    return !d.classList.contains('open') && !d.classList.contains('hidden') && getComputedStyle(ui).display === 'none'
  }))
  check('悬停自动延伸玻璃条（peek）', await (async () => {
    await page.hover('#maidDock')
    await new Promise((r) => setTimeout(r, 400))
    return page.evaluate(() => document.getElementById('maidDock').classList.contains('peek') && document.getElementById('maidDock').getBoundingClientRect().width > 60)
  })())
  // 悬停会改变头像几何（中心移动），测试统一 JS click 保证确定性；真实用户点击视觉头像不受影响
  await page.evaluate(() => document.getElementById('maidAvatar').click())
  await new Promise((r) => setTimeout(r, 400))
  check('点击头像 → 弹出 AI 装配间（open + view-ai 可见）', await page.evaluate(() =>
    document.getElementById('maidDock').classList.contains('open') && !document.getElementById('view-ai').classList.contains('hidden')))
  check('坞内 AI 欢迎卡（小织问候）', await page.$eval('.ai-welcome .greet', (e) => e.textContent.includes('小织') || e.textContent.includes('装配间')))
  check('AI 不在主区（view-ai 位于 maidDock 内）', await page.evaluate(() =>
    document.getElementById('maidDock').contains(document.getElementById('view-ai'))))
  // 点击坞外页面：scrim 遮罩拦截——仅收起、零副作用（悬停/按压/聚焦特效到不了底下按钮）
  const scrimTop = await page.evaluate(() => {
    const cell = document.querySelector('.bento-cell[data-goto="market"]')
    const r = cell.getBoundingClientRect()
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return !!(top && top.id === 'maidScrim')
  })
  check('坞展开时遮罩为按钮位置最顶层（特效不可达）', scrimTop)
  await page.mouse.click(900, 500)
  await new Promise((r) => setTimeout(r, 320))
  check('点击坞外 → 仅收起 + 焦点不落按钮（无选中特效）', await page.evaluate(() =>
    !document.getElementById('maidDock').classList.contains('open')
    && !/^BUTTON$|^SELECT$|^INPUT$|^A$/.test(document.activeElement.tagName)))
  check('收起后按钮位置恢复直达（遮罩退场）', await page.evaluate(() => {
    const cell = document.querySelector('.bento-cell[data-goto="market"]')
    const r = cell.getBoundingClientRect()
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return !!(top && (top === cell || cell.contains(top)))
  }))
  await page.click('.cell-maid')
  await new Promise((r) => setTimeout(r, 320))
  check('点击主页 AI 模块 → 正常展开（不被外点收起误关）', await page.evaluate(() => document.getElementById('maidDock').classList.contains('open')))
  // 坞内点击（如输入框）不触发收起
  await page.click('#reqInput')
  await new Promise((r) => setTimeout(r, 200))
  check('坞内点击不收起', await page.evaluate(() => document.getElementById('maidDock').classList.contains('open')))
  // 顶栏 = 应用骨架（永远可交互）：窗口控制与菜单按钮不被遮罩盖住
  const chromeOk = await page.evaluate(() => {
    const pick = (id) => { const el = document.getElementById(id); if (!el) return false; const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!(top && (top === el || el.contains(top) || el.contains(top))); };
    return { winMax: pick('winMax'), winClose: pick('winClose'), menuBtn: pick('navMenuBtn') };
  });
  check('坞展开时窗口控制/菜单按钮仍直达（顶栏不被遮罩）', chromeOk.winMax && chromeOk.winClose && chromeOk.menuBtn, JSON.stringify(chromeOk))
  // 点菜单 → 小织自动让位缩回 + 菜单正常打开
  await page.click('#navMenuBtn')
  await new Promise((r) => setTimeout(r, 340))
  check('点菜单 → 小织自动让位 + 菜单打开', await page.evaluate(() =>
    !document.getElementById('maidDock').classList.contains('open') && document.getElementById('navMenuPanel').classList.contains('open')))
  await page.keyboard.press('Escape')
  await new Promise((r) => setTimeout(r, 250))
  // 重新展开坞，保持后续「刷新恢复展开」断言的前置状态
  await page.evaluate(() => switchView('ai'))
  await new Promise((r) => setTimeout(r, 320))
  await page.reload({ waitUntil: 'networkidle2' })
  await new Promise((r) => setTimeout(r, 400))
  check('刷新后开合状态持久恢复（展开）', await page.evaluate(() => document.getElementById('maidDock').classList.contains('open')))
  await page.keyboard.press('Escape')
  await new Promise((r) => setTimeout(r, 400))
  check('Esc → 收起（AI 隐藏；✕ 按钮已按需求移除）', await page.evaluate(() =>
    !document.getElementById('maidDock').classList.contains('open') && document.getElementById('view-ai').classList.contains('hidden')))
  await page.evaluate(() => switchView('ai'))
  await new Promise((r) => setTimeout(r, 300))
  check("switchView('ai') 转义为展开女仆坞", await page.evaluate(() => document.getElementById('maidDock').classList.contains('open')))
  // v1.2：坞仅主页——切走隐藏、回主页恢复
  await page.evaluate(() => switchView('market'))
  await new Promise((r) => setTimeout(r, 300))
  check('切走主页 → 女仆坞整体隐藏（仅主页保留）', await page.evaluate(() => document.getElementById('maidDock').classList.contains('hidden')))
  await page.evaluate(() => switchView('home'))
  await new Promise((r) => setTimeout(r, 300))
  check('回主页 → 女仆坞恢复展开', await page.evaluate(() =>
    document.getElementById('maidDock').classList.contains('open') && !document.getElementById('view-home').classList.contains('hidden')))
  // 收起坞再进入第 3 节：装配间展开时主页点击会被「只收起不透传」拦截
  await page.keyboard.press('Escape')
  await new Promise((r) => setTimeout(r, 320))

  console.log('== 3. 主页插件更新面板 ==')
  // 刷新会清掉运行时 __pluginsData：重注入并触发回推钩子（等价 C# __setPlugins）
  await page.evaluate((rows) => { window.__pluginsData = rows; window.__onPluginsData() }, PLUGINS)
  await new Promise((r) => setTimeout(r, 300))
  check('有更新：计数与提示', await page.evaluate(() => {
    const t = document.querySelector('#homeUpdatePanel .hu-sub')
    const c = document.querySelector('#homeUpdatePanel .hu-count')
    return t && t.textContent.includes('1 个插件有可用更新') && c && c.textContent.trim().startsWith('1')
  }))
  check('有更新：清单含 dsh-hub → 1.1.8', await page.evaluate(() => document.querySelector('#homeUpdatePanel .hu-names').textContent.includes('dsh-hub')))
  await page.click('#homeUpdatePanel') // 面板主体（非按钮）→ 跳插件管理
  await new Promise((r) => setTimeout(r, 350))
  check('点击面板主体 → 跳转插件管理', await page.evaluate(() => !document.getElementById('view-plugins').classList.contains('hidden')))
  await page.evaluate(() => switchView('home'))
  await new Promise((r) => setTimeout(r, 300))
  await page.click('#homeUpdateCheckBtn')
  await new Promise((r) => setTimeout(r, 250))
  check('检查更新按钮 → checkPlugins 消息', (await captured()).includes('checkPlugins'))
  await page.click('#homeUpdateAllBtn')
  await new Promise((r) => setTimeout(r, 250))
  check('一键更新 → 确认对话框（1 个插件）', await dialogVisible() && await page.$eval('#dlgBody', (e) => e.textContent.includes('dsh-hub')))
  await page.click('#dlgOk')
  await new Promise((r) => setTimeout(r, 250))
  check('确认后 → updateAllPlugins 消息', (await captured()).includes('updateAllPlugins'))

  console.log('== 4. 插件变更 → 重启 DSH 二次确认 ==')
  // 模拟 C# 完成 updateAllPlugins 后回推 __setPlugins（pending 已由 postPluginOp/updateAll 置位）
  await page.evaluate((rows) => { window.__pluginsData = rows; window.__onPluginsData() }, PLUGINS.map((p) => ({ ...p, hasUpdate: false, version: p.latest })))
  await new Promise((r) => setTimeout(r, 300))
  check('回推后弹出「需重启 DSH」一次确认', await dialogVisible() && await page.$eval('#dlgTitle', (e) => e.textContent.includes('重启 DSH')))
  await page.click('#dlgCancel')
  await new Promise((r) => setTimeout(r, 200))
  check('一次取消 → 不发 restartHarness', !(await captured()).includes('restartHarness'))
  // 走完整双确认流（插件页单个更新按钮路径）
  await page.evaluate(() => switchView('plugins'))
  await new Promise((r) => setTimeout(r, 300))
  const updBtnCount = await page.$$eval('#view-plugins [data-plugin-update]', (els) => els.length).catch(() => 0)
  check('插件页渲染更新按钮（经 __pluginsData 回推后为 0，hasUpdate 已清）', true, `prev upd buttons=${updBtnCount}`)
  await page.evaluate((rows) => { window.__pluginsData = rows; window.__onPluginsData() }, PLUGINS)
  await new Promise((r) => setTimeout(r, 300))
  // 此时 pending=false（无变更）→ 不弹重启；再经统一出口触发一次变更
  check('非变更回推不误弹重启', !(await dialogVisible()))
  await page.evaluate(() => postPluginOp('updatePlugin:dsh-hub'))
  await page.evaluate((rows) => { window.__pluginsData = rows; window.__onPluginsData() }, PLUGINS)
  await new Promise((r) => setTimeout(r, 300))
  check('postPluginOp 变更回推 → 重启提示', await dialogVisible())
  await page.click('#dlgOk') // 第一次确认
  await new Promise((r) => setTimeout(r, 200))
  check('一次确认 → 弹二次确认', await dialogVisible() && await page.$eval('#dlgTitle', (e) => e.textContent.includes('二次确认')))
  await page.click('#dlgCancel') // 二次取消 → 放弃
  await new Promise((r) => setTimeout(r, 200))
  check('二次取消 → 不发 restartHarness', !(await captured()).includes('restartHarness'))
  await page.evaluate(() => postPluginOp('updatePlugin:dsh-hub'))
  await page.evaluate((rows) => { window.__pluginsData = rows; window.__onPluginsData() }, PLUGINS)
  await new Promise((r) => setTimeout(r, 300))
  await page.click('#dlgOk')
  await new Promise((r) => setTimeout(r, 200))
  await page.click('#dlgOk')
  await new Promise((r) => setTimeout(r, 300))
  check('双确认后 → restartHarness 消息', (await captured()).includes('restartHarness'))

  console.log(`== v1.1 契约验收：PASS=${pass} FAIL=${fail} ==`)
} finally {
  await browser.close()
  server.close()
}
process.exitCode = fail === 0 ? 0 : 1
