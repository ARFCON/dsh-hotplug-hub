#!/usr/bin/env node
/**
 * scripts/qa11-v11-layout.mjs — 布局几何与 v4 一体化总控台大面板主页验收（puppeteer-core + 本机 Edge）
 *
 * 布局契约（v4）：
 *   · 女仆坞已移除——AI 装配间改为主页大面板左栏常驻舱（.home-ai-col + #homeAiPanel）；
 *   · 主页 = 一体化总控台大面板（.home-console：左栏 AI 装配间 + 右栏启动/状态/入口）；
 *   · 主区全宽（无左缘让位）；顶部横排主导航（#mainNav，9 视图项，当前项底部指示条高亮）。
 *
 * 断言分组：
 *   1) 1280 宽主页：大面板 / 主区全宽 / 启动键 / 快捷入口 6 格 / 无溢出 / 横排菜单
 *   2) AI 装配间常驻左栏：ai-zone 渲染 / 宽 ≥320 / 设置按钮可命中
 *   3) 大启动键 + 环境自检 3 项 + 服务操作排
 *   4) 其他视图：主区全宽、无溢出
 *   5) 900 / 720 / 500 宽：主页无横向溢出
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
    const main = document.querySelector('main.main').getBoundingClientRect()
    const shell = document.querySelector('.home-shell')
    return {
      vw: window.innerWidth,
      main: { x: Math.round(main.x), w: Math.round(main.width) },
      shellPadL: shell ? Math.round(parseFloat(getComputedStyle(shell).paddingLeft)) : -1,
      docScrollW: document.documentElement.scrollWidth
    }
  })

  console.log('== 1. 1280 宽 · 主页（一体化总控台大面板） ==')
  let g = await geom()
  check('女仆坞已移除（无 maidDock）', await page.evaluate(() => !document.getElementById('maidDock')))
  check('主区全宽', g.main.x === 0 && g.main.w >= 1276, `x=${g.main.x} w=${g.main.w}`)
  check('无横向溢出', g.docScrollW <= 1280, `scrollW=${g.docScrollW}`)
  const pcl = await page.evaluate(() => {
    const consoleEl = document.querySelector('.home-console')
    const btn = document.getElementById('homeLaunchBtn')
    const aiPanel = document.getElementById('homeAiPanel')
    return {
      exists: !!consoleEl, launchBtn: !!btn, aiPanel: !!aiPanel,
      tiles: document.querySelectorAll('.home-tile').length,
      navItems: document.querySelectorAll('#mainNav .nav-item').length,
      envs: document.querySelectorAll('.launch-env .env').length
    }
  })
  check('大面板 .home-console 渲染', pcl.exists, JSON.stringify(pcl))
  check('启动键存在', pcl.launchBtn)
  check('AI 装配间常驻左栏（homeAiPanel）', pcl.aiPanel)
  check('快捷入口 6 格', pcl.tiles === 6, `tiles=${pcl.tiles}`)
  check('顶部横排菜单 9 项', pcl.navItems === 9, `nav=${pcl.navItems}`)
  check('环境自检 3 项', pcl.envs === 3, `envs=${pcl.envs}`)
  // 主页标题与内容左缘对齐（无女仆坞让位）
  const title = await page.evaluate(() => {
    const h = document.querySelector('.topbar h1')
    const shell = document.querySelector('.home-shell')
    const sr = shell.getBoundingClientRect()
    return {
      x: Math.round(h.getBoundingClientRect().left),
      shellContentL: Math.round(sr.left + parseFloat(getComputedStyle(shell).paddingLeft))
    }
  })
  check('主页标题与内容左缘对齐', title.x === title.shellContentL, `title.x=${title.x} shellContentL=${title.shellContentL}`)

  // 顶部横排菜单：贴标题栏下方
  const navGeo = await page.evaluate(() => {
    const nav = document.getElementById('mainNav').getBoundingClientRect()
    return { top: Math.round(nav.top), w: Math.round(nav.width), vw: window.innerWidth }
  })
  check('横排菜单在标题栏下方（top≈56）', navGeo.top >= 54 && navGeo.top <= 58, `top=${navGeo.top}`)
  check('横排菜单不出右视口', navGeo.w <= navGeo.vw, `w=${navGeo.w} vw=${navGeo.vw}`)

  console.log('== 2. AI 装配间常驻左栏（大面板） ==')
  check('AI 装配间已渲染（ai-zone）', await page.evaluate(() => !!document.querySelector('#homeAiPanel .ai-zone')))
  const aiGeom = await page.evaluate(() => {
    const col = document.querySelector('.home-ai-col').getBoundingClientRect()
    return { cw: Math.round(col.width) }
  })
  check('AI 装配间在左栏（宽 ≥ 320）', aiGeom.cw >= 320, JSON.stringify(aiGeom))
  const hitBtn = await page.evaluate(() => {
    const btn = document.getElementById('aiSettingsBtn')
    if (!btn) return false
    const b = btn.getBoundingClientRect()
    const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)
    return hit === btn || btn.contains(hit)
  })
  check('设置按钮可命中（无遮挡）', hitBtn)

  console.log('== 3. 大启动键 + 环境自检 + 服务操作 ==')
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
  check('服务操作含 API 配置/客户端中心/修改配置/选择客户端', !!launch && launch.labels.includes('API 配置') && launch.labels.includes('客户端中心') && launch.labels.includes('修改配置') && launch.labels.includes('选择客户端'), launch ? launch.labels : '')
  check('环境自检 3 项', !!launch && launch.env === 3, launch ? `env=${launch.env}` : '')

  console.log('== 4. 其他视图：主区全宽、无溢出 ==')
  for (const v of ['skills', 'market', 'plugins']) {
    await page.evaluate((x) => switchView(x), v)
    await new Promise((r) => setTimeout(r, 300))
    g = await geom()
    check(`${v} 视图：主区全宽 + 无溢出`, g.main.w >= 1276 && g.docScrollW <= 1280, `w=${g.main.w} scrollW=${g.docScrollW}`)
  }

  console.log('== 5. 多档宽度：无横向溢出 ==')
  for (const w of [900, 720, 500]) {
    await page.setViewport({ width: w, height: 700 })
    await page.evaluate(() => switchView('home'))
    await new Promise((r) => setTimeout(r, 320))
    g = await geom()
    check(`${w} 宽主页无横向溢出`, g.docScrollW <= w, `scrollW=${g.docScrollW}`)
  }

  console.log(`== 布局几何验收：PASS=${pass} FAIL=${fail} ==`)
} finally {
  await browser.close()
  server.close()
}
process.exitCode = fail === 0 ? 0 : 1
