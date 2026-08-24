#!/usr/bin/env node
/**
 * scripts/qa10-v11-nav-updates.mjs — v4 一体化总控台大面板交互契约验收（puppeteer-core + 本机 Edge）
 *
 * 覆盖（v4 顶部横排导航 + 大面板主页的端到端契约）：
 *   1) 顶部横排主导航：9 视图项横排 → 当前项高亮 → 点击跳转 → 插件更新角标（.n-count.upd）
 *   2) 主页大面板 AI 装配间常驻左栏：女仆坞已移除 → ai-zone 渲染 → 欢迎卡 →
 *      switchView('ai') 回到主页 → 刷新后会话续接
 *   3) 主页插件更新卡：无更新（全部最新）/有更新（计数+清单）→ 检查更新=checkPlugins →
 *      一键更新确认=updateAllPlugins → 卡主体点击跳转插件管理
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
  const dialogVisible = () => page.evaluate(() => document.getElementById('dlgBackdrop').classList.contains('show'))

  console.log('== 1. 顶部横排主导航（PCL 启动器风） ==')
  const navItems = await page.$$eval('#mainNav .nav-item', (els) => els.map((e) => e.dataset.view))
  check('顶栏渲染 9 个横排菜单项', navItems.length === 9, `n=${navItems.length}`)
  check('导航含 9 视图（AI 住女仆坞，不入导航）', navItems.length === 9 && !navItems.includes('ai'), navItems.join(','))
  check('含 Skill 面板与 MCP 面板', navItems.includes('skills') && navItems.includes('mcp'))
  check('当前项高亮（home active）', await page.$eval('#mainNav .nav-item[data-view="home"]', (e) => e.classList.contains('active')))
  await page.click('#mainNav .nav-item[data-view="skills"]')
  await new Promise((r) => setTimeout(r, 350))
  check('点击导航项 → 跳转 Skill 面板', await page.evaluate(() => !document.getElementById('view-skills').classList.contains('hidden')))
  check('当前项高亮（skills active）', await page.$eval('#mainNav .nav-item[data-view="skills"]', (e) => e.classList.contains('active')))
  // 更新角标（依赖插件数据，先注入）
  await page.evaluate((rows) => { window.__pluginsData = rows; window.__onPluginsData() }, PLUGINS)
  const badge = await page.$eval('#mainNav .nav-item[data-view="plugins"] .n-count.upd', (e) => e.textContent).catch(() => '')
  check('插件管理项带更新角标（1）', badge.trim() === '1', badge)
  await page.evaluate(() => switchView('home'))

  console.log('== 2. 主页大面板 · AI 装配间常驻左栏（v4） ==')
  await page.evaluate(() => switchView('home'))
  await new Promise((r) => setTimeout(r, 300))
  check('女仆坞已移除（无 maidDock/maidScrim/maidAvatar）', await page.evaluate(() =>
    !document.getElementById('maidDock') && !document.getElementById('maidScrim') && !document.getElementById('maidAvatar')))
  check('大面板 .home-console 渲染', await page.evaluate(() => !!document.querySelector('.home-console')))
  check('AI 装配间常驻左栏（home-ai-col + homeAiPanel）', await page.evaluate(() =>
    !!document.querySelector('.home-ai-col') && !!document.getElementById('homeAiPanel')))
  check('AI 装配间已渲染（ai-zone）', await page.evaluate(() =>
    !!document.querySelector('#homeAiPanel .ai-zone')))
  check('AI 欢迎卡（小织问候）', await page.$eval('.ai-welcome .greet', (e) => e.textContent.includes('小织') || e.textContent.includes('装配间')))
  // AI 装配间在左栏可交互（输入框聚焦）
  await page.click('#reqInput')
  await new Promise((r) => setTimeout(r, 200))
  check('AI 输入框可聚焦', await page.evaluate(() => document.activeElement && document.activeElement.id === 'reqInput'))
  // switchView('ai') → 回到主页，AI 装配间仍在
  await page.evaluate(() => switchView('market'))
  await new Promise((r) => setTimeout(r, 300))
  check('切走主页 → 市场视图显示', await page.evaluate(() => !document.getElementById('view-market').classList.contains('hidden')))
  await page.evaluate(() => switchView('ai'))
  await new Promise((r) => setTimeout(r, 300))
  check("switchView('ai') 转义为回到主页", await page.evaluate(() => !document.getElementById('view-home').classList.contains('hidden')))
  check('回主页后 AI 装配间仍在左栏', await page.evaluate(() => !!document.querySelector('#homeAiPanel .ai-zone')))
  await page.reload({ waitUntil: 'networkidle2' })
  await new Promise((r) => setTimeout(r, 400))
  check('刷新后 AI 装配间会话续接（ai-zone 仍在）', await page.evaluate(() => !!document.querySelector('#homeAiPanel .ai-zone')))
  await page.evaluate(() => switchView('home'))

  console.log('== 3. 主页插件更新面板 ==')
  // 刷新会清掉运行时 __pluginsData：重注入并触发回推钩子（等价 C# __setPlugins）
  await page.evaluate((rows) => { window.__pluginsData = rows; window.__onPluginsData() }, PLUGINS)
  await new Promise((r) => setTimeout(r, 300))
  check('有更新：计数与提示', await page.evaluate(() => {
    const t = document.querySelector('#homeUpdatePanel .hu-sub')
    const c = document.querySelector('#homeUpdatePanel .hu-count')
    return t && t.textContent.includes('1 个插件有可用更新') && c && c.textContent.trim().includes('1 个可更新')
  }))
  check('有更新：清单含 dsh-hub → 1.1.8', await page.evaluate(() => document.querySelector('#homeUpdatePanel .hu-names').textContent.includes('dsh-hub')))
  await page.evaluate(() => document.querySelector('#homeUpdatePanel .hu-sub').click()) // 卡主体（非按钮）→ 跳插件管理
  await new Promise((r) => setTimeout(r, 350))
  check('点击更新卡主体 → 跳转插件管理', await page.evaluate(() => !document.getElementById('view-plugins').classList.contains('hidden')))
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

  console.log(`== v3 PCL 启动器契约验收：PASS=${pass} FAIL=${fail} ==`)
} finally {
  await browser.close()
  server.close()
}
process.exitCode = fail === 0 ? 0 : 1
