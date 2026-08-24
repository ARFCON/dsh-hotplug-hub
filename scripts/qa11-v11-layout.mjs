#!/usr/bin/env node
/**
 * scripts/qa11-v11-layout.mjs — 布局几何与 v3 PCL 启动器主页重设计验收（puppeteer-core + 本机 Edge）
 *
 * 布局契约（v3）：
 *   · 女仆坞 = 覆盖式玻璃标签（fixed），仅主页显示：默认 34px 细条（无文字）→ 悬停延伸 ~78px
 *     （peek，仍无文字）→ 点击弹出 400px AI 装配间；切走主页整体隐藏，回主页恢复；
 *   · 主区始终全宽（坞为覆盖层，不挤占布局）；主页内容左缘让位 64px 给玻璃标签；
 *   · 主页 = PCL 启动器布局（左启动卡大绿启动键 + 环境自检 + 右卡片列快捷入口 6 格）；
 *   · 顶部横排主导航（#mainNav，9 视图项，当前项底部指示条高亮）。
 *
 * 断言分组：
 *   1) 1280 宽主页：坞标签 / 主区全宽 / 左缘让位 / PCL 启动卡 / 无溢出 / 横排菜单
 *   2) 悬停 peek：延伸且无文字界面
 *   3) 弹出 open：400px 玻璃面板 / AI 占满 / 主区仍全宽 / 设置按钮可命中
 *   4) 滚动锚定：滚动后坞不动、按钮仍可命中
 *   5) PCL 启动卡：大绿启动键 / 环境自检 3 项 / 服务操作排
 *   6) 其他视图：坞隐藏、主区全宽、无溢出
 *   7) 900 / 720 / 500 宽：收起与展开两态均无横向溢出
 *
 * 用法：node scripts/qa11-v11-layout.mjs（自起 3997 端口静态服务）
 */
import { launch } from 'puppeteer-core'
import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { join, extname, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STATIC_ROOT = join(ROOT, 'dsh-hotplug-hub', 'dsh-pack-hub')
const PORT = 3997

const server = createServer((req, res) => {
  let f = (req.url || '/').split('?')[0]
  if (f === '/') f = '/prototype.html'
  const p = join(STATIC_ROOT, f)
  if (!existsSync(p)) { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'Content-Type': extname(p) === '.html' ? 'text/html; charset=utf-8' : 'text/plain' })
  res.end(readFileSync(p))
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
const browser = await launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] })

let pass = 0
let fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + (detail ? '：' + detail : '')) }
}

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 860 })
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2' })
  await new Promise((r) => setTimeout(r, 300))

  const geom = () => page.evaluate(() => {
    const dock = document.getElementById('maidDock').getBoundingClientRect()
    const main = document.querySelector('main.main').getBoundingClientRect()
    const shell = document.querySelector('.home-shell')
    return {
      vw: window.innerWidth,
      dockHidden: document.getElementById('maidDock').classList.contains('hidden'),
      dock: { x: Math.round(dock.x), y: Math.round(dock.y), w: Math.round(dock.width) },
      main: { x: Math.round(main.x), w: Math.round(main.width) },
      shellPadL: shell ? Math.round(parseFloat(getComputedStyle(shell).paddingLeft)) : -1,
      docScrollW: document.documentElement.scrollWidth
    }
  })

  console.log('== 1. 1280 宽 · 主页（坞标签 + PCL 启动卡） ==')
  let g = await geom()
  check('女仆坞标签可见：左缘 34px 细条', !g.dockHidden && g.dock.x === 0 && g.dock.w >= 30 && g.dock.w <= 36, JSON.stringify(g.dock))
  check('主区全宽（覆盖式坞不挤占布局）', g.main.x === 0 && g.main.w >= 1276, `x=${g.main.x} w=${g.main.w}`)
  check('主页内容左缘让位 ≥56px（玻璃标签空间）', g.shellPadL >= 56, `padL=${g.shellPadL}`)
  check('无横向溢出', g.docScrollW <= 1280, `scrollW=${g.docScrollW}`)
  const pcl = await page.evaluate(() => {
    const lc = document.querySelector('.launch-card')
    const btn = document.getElementById('homeLaunchBtn')
    return {
      exists: !!lc, launchBtn: !!btn,
      tiles: document.querySelectorAll('.home-tile').length,
      navItems: document.querySelectorAll('#mainNav .nav-item').length,
      envs: document.querySelectorAll('.launch-env .env').length
    }
  })
  check('PCL 启动器：启动卡 + 大启动键渲染', pcl.exists && pcl.launchBtn, JSON.stringify(pcl))
  check('快捷入口 6 格', pcl.tiles === 6, `tiles=${pcl.tiles}`)
  check('顶部横排菜单 9 项', pcl.navItems === 9, `nav=${pcl.navItems}`)
  check('环境自检 3 项', pcl.envs === 3, `envs=${pcl.envs}`)
  // 主页标题条为女仆坞让位：「主页」标题不被 34px 玻璃标签遮挡，且与启动卡左缘对齐
  const title = await page.evaluate(() => {
    const h = document.querySelector('.topbar h1')
    const dock = document.getElementById('maidDock')
    const shell = document.querySelector('.home-shell')
    const sr = shell.getBoundingClientRect()
    return {
      x: Math.round(h.getBoundingClientRect().left),
      dockR: Math.round(dock.getBoundingClientRect().right),
      shellContentL: Math.round(sr.left + parseFloat(getComputedStyle(shell).paddingLeft)),
      onHome: document.body.classList.contains('on-home')
    }
  })
  check('主页标题不被女仆坞遮挡（起点在坞右侧）', title.onHome && title.x > title.dockR, `title.x=${title.x} dockR=${title.dockR}`)
  check('主页标题与启动卡内容左缘对齐', title.x === title.shellContentL, `title.x=${title.x} shellContentL=${title.shellContentL}`)

  // 顶部横排菜单：贴标题栏下方，不与左缘女仆坞玻璃标签重叠
  const navGeo = await page.evaluate(() => {
    const nav = document.getElementById('mainNav').getBoundingClientRect()
    return { top: Math.round(nav.top), w: Math.round(nav.width), vw: window.innerWidth }
  })
  check('横排菜单在标题栏下方（top≈56）', navGeo.top >= 54 && navGeo.top <= 58, `top=${navGeo.top}`)
  check('横排菜单不出右视口', navGeo.w <= navGeo.vw, `w=${navGeo.w} vw=${navGeo.vw}`)

  console.log('== 2. 悬停 peek（无文字玻璃延伸） ==')
  await page.hover('#maidDock')
  await new Promise((r) => setTimeout(r, 420))
  const peek = await page.evaluate(() => {
    const d = document.getElementById('maidDock')
    const ui = d.querySelector('.maid-open-ui')
    return { peek: d.classList.contains('peek'), w: Math.round(d.getBoundingClientRect().width), uiHidden: getComputedStyle(ui).display === 'none' }
  })
  check('悬停自动延伸玻璃条（~78px）', peek.peek && peek.w >= 70 && peek.w <= 86, JSON.stringify(peek))
  check('延伸态无文字界面（弹出 UI 仍隐藏）', peek.uiHidden)
  await page.mouse.move(900, 500) // 移开
  // 260ms 防抖 + 300ms 宽度过渡 ≈ 560ms，留足余量避免测到过渡半程宽度
  await new Promise((r) => setTimeout(r, 800))
  const retracted = await page.evaluate(() => {
    const d = document.getElementById('maidDock')
    return !d.classList.contains('peek') && Math.round(d.getBoundingClientRect().width) <= 36
  })
  check('移开自动回缩（260ms 防抖）', retracted)

  console.log('== 3. 点击弹出 AI 装配间 ==')
  await page.evaluate(() => switchView('ai'))
  await new Promise((r) => setTimeout(r, 420))
  g = await geom()
  check('弹出 400px 玻璃面板', g.dock.w >= 396 && g.dock.w <= 404, `w=${g.dock.w}`)
  check('主区仍全宽（内容从玻璃下滑过）', g.main.x === 0 && g.main.w >= 1276, `w=${g.main.w}`)
  check('AI 装配间占满坞体（宽≥380 高≥500）', await page.evaluate(() => {
    const z = document.querySelector('.ai-zone').getBoundingClientRect()
    return Math.round(z.width) >= 380 && z.height >= 500
  }))
  const hitBtn = await page.evaluate(() => {
    const btn = document.getElementById('aiSettingsBtn')
    if (!btn) return false
    const b = btn.getBoundingClientRect()
    const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)
    return hit === btn || btn.contains(hit)
  })
  check('设置按钮可命中（无遮挡）', hitBtn)

  console.log('== 4. 滚动锚定（fixed 覆盖层） ==')
  await page.evaluate(() => window.scrollTo(0, 300))
  await new Promise((r) => setTimeout(r, 250))
  const anchored = await page.evaluate(() => {
    const d = document.getElementById('maidDock').getBoundingClientRect()
    const btn = document.getElementById('aiSettingsBtn')
    const b = btn.getBoundingClientRect()
    const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)
    return { y: Math.round(d.y), hitOk: hit === btn || btn.contains(hit) }
  })
  check('滚动 300px 后坞不动（y≈56）且按钮仍可命中', anchored.y >= 54 && anchored.y <= 58 && anchored.hitOk, JSON.stringify(anchored))
  await page.evaluate(() => { window.scrollTo(0, 0); switchView('home'); openMaidDock(false); })

  console.log('== 5. PCL 启动卡（大绿启动键 + 环境自检 + 服务操作） ==')
  const launch = await page.evaluate(() => {
    const btn = document.getElementById('homeLaunchBtn')
    const api = document.getElementById('homeApiBtn')
    const client = document.getElementById('homeClientBtn')
    const repair = document.getElementById('homeRepairBtn')
    const choose = document.getElementById('homeChooseBtn')
    if (!btn || !api || !client || !repair || !choose) return null
    const b = btn.getBoundingClientRect()
    return {
      h: Math.round(b.height),
      labels: api.textContent.trim() + '/' + client.textContent.trim() + '/' + repair.textContent.trim() + '/' + choose.textContent.trim(),
      env: document.querySelectorAll('.launch-env .env').length
    }
  })
  check('大启动键为高按钮（h≥58）', !!launch && launch.h >= 58, JSON.stringify(launch))
  check('启动卡含 API 配置/客户端中心/修改配置/选择客户端', !!launch && launch.labels.includes('API 配置') && launch.labels.includes('客户端中心') && launch.labels.includes('修改配置') && launch.labels.includes('选择客户端'), launch ? launch.labels : '')
  check('环境自检 3 项', !!launch && launch.env === 3, launch ? `env=${launch.env}` : '')

  console.log('== 6. 其他视图：坞隐藏、主区全宽 ==')
  for (const v of ['skills', 'market', 'plugins']) {
    await page.evaluate((x) => switchView(x), v)
    await new Promise((r) => setTimeout(r, 300))
    g = await geom()
    check(`${v} 视图：坞隐藏 + 主区全宽 + 无溢出`, g.dockHidden && g.main.w >= 1276 && g.docScrollW <= 1280, `dockHidden=${g.dockHidden} w=${g.main.w} scrollW=${g.docScrollW}`)
  }

  console.log('== 7. 多档宽度：收起与展开两态无横向溢出 ==')
  for (const w of [900, 720, 500]) {
    await page.setViewport({ width: w, height: 700 })
    await page.evaluate(() => { switchView('home'); openMaidDock(false); })
    await new Promise((r) => setTimeout(r, 320))
    g = await geom()
    check(`${w} 宽收起态无横向溢出`, g.docScrollW <= w, `scrollW=${g.docScrollW}`)
    await page.evaluate(() => openMaidDock(true))
    await new Promise((r) => setTimeout(r, 380))
    g = await geom()
    check(`${w} 宽展开态无横向溢出（覆盖式坞）`, g.docScrollW <= w, `scrollW=${g.docScrollW}`)
    await page.evaluate(() => openMaidDock(false))
  }

  console.log(`== 布局几何验收：PASS=${pass} FAIL=${fail} ==`)
} finally {
  await browser.close()
  server.close()
}
process.exitCode = fail === 0 ? 0 : 1
