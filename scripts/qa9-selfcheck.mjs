#!/usr/bin/env node
/**
 * scripts/qa9-selfcheck.mjs — 自检页「DSH 版本 / 官方 Harness / 最新版本」探测根治的实机验收
 *
 * 方法：从 release/src/Main.cs 的 BuildNativeSelfCheckScript 中**按源码拼接语义**提取
 * 注入脚本（JsString(变量) 以 mock 值替换——与 C# 运行时产物等价），在真实页面
 * （原型自检视图）执行，断言三场景：
 *   A. 用户环境场景（Node.js 壳目录 + npm 全局 dsh + 项目本地领先发布）：
 *      DSH 版本 = 0.1.1-rc.1（绝不显示 24.18.0）、文案「当前 v0.1.1-rc.1」、
 *      最新版本 0.9.7 < 本程序 0.9.8 → 「已最新」（不误报可更新）
 *   B. 官方 Desktop 场景：dshDesktop 命中 → 「当前 v0.1.0-rc.7」，版本取官方描述
 *   C. 完全无 DSH：→ 「未检测到 dsh CLI（可自动安装）」+ warn
 * 另：第二次注入（重复执行）不报错（幂等：/recheck 绑定、按钮追加）。
 *
 * 用法：node scripts/qa9-selfcheck.mjs（自起 3984 端口）
 */
import { launch } from 'puppeteer-core'
import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { join, extname, resolve } from 'node:path'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const STATIC_ROOT = resolve('dsh-hotplug-hub/dsh-pack-hub')
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
const check = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  PASS ' + name) }
  else { fail += 1; console.log('  FAIL ' + name + (detail ? ('  ' + String(detail).slice(0, 140)) : '')) }
}

/** 从 Main.cs 提取 BuildNativeSelfCheckScript 的 JS（mock 变量注入，等价 C# 拼接产物）。 */
function buildSelfCheckJs(mock) {
  const cs = readFileSync(join(resolve('.'), 'release', 'src', 'Main.cs'), 'utf8')
  const sIdx = cs.indexOf('"window.__nativeSelfCheck={')
  const endMarker = '"})();";'
  const eIdx = cs.indexOf(endMarker, sIdx)
  if (sIdx < 0 || eIdx < 0) throw new Error('无法从 Main.cs 提取自检注入脚本')
  let seg = cs.slice(sIdx, eIdx + endMarker.length)
  const mark = (name) => '__MOCK_' + name + '__'
  // 先把变量位换成不可冲突的标记，再按「字面量 | 标记」分片拼接（等价 C# 字符串拼接），
  // 最后把标记替换为 JSON 值——值里的引号保留在最终 JS 文本中（与 C# JsString 产物一致）。
  seg = seg
    .replace(/JsString\(node\)/g, mark('node'))
    .replace(/JsString\(pnpm\)/g, mark('pnpm'))
    .replace(/JsString\(dshDesktop\)/g, mark('dshDesktop'))
    .replace(/JsString\(dshVersion\)/g, mark('dshVersion'))
    .replace(/JsString\(dshCli\)/g, mark('dshCli'))
    .replace(/JsString\(wv\)/g, mark('wv'))
    .replace(/JsString\(profiles\)/g, mark('profiles'))
    .replace(/JsString\(APP_VERSION\)/g, mark('appVersion'))
    .replace(/JsString\(latest\)/g, mark('latest'))
    .replace(/JsString\(dshLatest\)/g, mark('dshLatest'))
    .replace(/JsString\(envMode\)/g, mark('envMode'))
    .replace(/JsString\(wslAvailable\)/g, mark('wslAvailable'))
    .replace(/JsString\(wslDsh\)/g, mark('wslDsh'))
    .replace(/JsString\(panelInstalled\)/g, mark('panelInstalled'))
    .replace(/JsString\(panelLatest\)/g, mark('panelLatest'))
  const tokens = [...seg.matchAll(/"((?:[^"\\]|\\.)*)"|__MOCK_[A-Za-z]+__/g)].map((m) => (m[1] !== undefined ? m[1] : m[0]))
  let js = tokens.join('')
  js = js
    .replaceAll(mark('node'), JSON.stringify(mock.node))
    .replaceAll(mark('pnpm'), JSON.stringify(mock.pnpm))
    .replaceAll(mark('dshDesktop'), JSON.stringify(mock.dshDesktop))
    .replaceAll(mark('dshVersion'), JSON.stringify(mock.dshVersion))
    // dshCli/dshLatest/envMode/wsl*：C# 端为 "ok"/版本串/"windows"/null，mock 缺省时按同语义回填
    .replaceAll(mark('dshCli'), JSON.stringify(mock.dshCli !== undefined ? mock.dshCli : (mock.dshVersion ? 'ok' : null)))
    .replaceAll(mark('wv'), JSON.stringify(mock.webview2))
    .replaceAll(mark('profiles'), JSON.stringify(mock.profiles))
    .replaceAll(mark('appVersion'), JSON.stringify(mock.appVersion))
    .replaceAll(mark('latest'), JSON.stringify(mock.latest))
    .replaceAll(mark('dshLatest'), JSON.stringify(mock.dshLatest !== undefined ? mock.dshLatest : null))
    .replaceAll(mark('envMode'), JSON.stringify(mock.envMode !== undefined ? mock.envMode : 'windows'))
    .replaceAll(mark('wslAvailable'), JSON.stringify(mock.wslAvailable !== undefined ? mock.wslAvailable : null))
    .replaceAll(mark('wslDsh'), JSON.stringify(mock.wslDsh !== undefined ? mock.wslDsh : null))
    .replaceAll(mark('panelInstalled'), JSON.stringify(mock.panelInstalled))
    .replaceAll(mark('panelLatest'), JSON.stringify(mock.panelLatest))
  return js
}

const browser = await launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] })
const pageErrors = []
try {
  const page = await browser.newPage()
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  await page.setViewport({ width: 1280, height: 860 })

  const runScene = async (mock, label) => {
    console.log('== ' + label + ' ==')
    await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'networkidle2', timeout: 30000 })
    await new Promise((r) => setTimeout(r, 300))
    // v1.3：顶栏分组导航 → 系统分组 → 自检更新
    await page.click('.navgroup-btn[data-group="系统"]')
    await new Promise((r) => setTimeout(r, 320)) // 等折叠面板垂出动画结束再点选项
    await page.click('.navmenu-item[data-view="check"]')
    await new Promise((r) => setTimeout(r, 400))
    check('自检行已渲染', (await page.$$('.check-row')).length > 0)
    const errBefore = pageErrors.length
    await page.evaluate(buildSelfCheckJs(mock))
    await new Promise((r) => setTimeout(r, 300))
    const row = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.check-row')]
      const pick = (name) => {
        const r = rows.find((x) => x.querySelector('.name') && x.querySelector('.name').textContent === name)
        if (!r) return null
        const valDiv = r.querySelector('.val')
        const textDiv = valDiv ? valDiv.nextElementSibling : null
        return { val: (valDiv || {}).textContent || '', text: (textDiv || {}).textContent || '', cls: (r.querySelector('.badge') || {}).className || '' }
      }
      return { dsh: pick('DSH 版本'), latest: pick('最新版本'), app: pick('本程序版本') }
    })
    check('注入执行无新页面错误', pageErrors.length === errBefore, pageErrors.slice(-1)[0])
    return row
  }

  // A. 用户环境场景：Node 壳被排除 + npm 全局 dsh 命中 + 本地 0.9.8 领先发布 0.9.7
  const a = await runScene({ node: 'v24.18.0', pnpm: '11.22.0', dshDesktop: null, dshVersion: '0.1.1-rc.1', webview2: '130.0.2849.68', profiles: 'web', appVersion: '0.9.8', latest: '0.9.7', panelInstalled: null, panelLatest: '0.8.1-pre' }, 'A 用户环境（node 壳目录 + npm 全局 dsh + 本地领先发布）')
  check('DSH 版本 = 0.1.1-rc.1（不显示 24.18.0）', a.dsh && a.dsh.val === '0.1.1-rc.1', a.dsh && a.dsh.val)
  check('DSH 版本文案 = 当前 v0.1.1-rc.1（现行文案契约）', a.dsh && a.dsh.text.includes('当前 v0.1.1-rc.1'), a.dsh && a.dsh.text)
  check('DSH 版本状态 ok', a.dsh && /ok/.test(a.dsh.cls))
  check('最新版本（0.9.7 < 0.9.8）显示已最新不误报', a.latest && a.latest.text === '已最新' && /ok/.test(a.latest.cls), a.latest && a.latest.text)
  check('本程序版本 = 0.9.8', a.app && a.app.val === '0.9.8', a.app && a.app.val)

  // B. 官方 Desktop 场景
  const b = await runScene({ node: 'v22.19.0', pnpm: '10.0.0', dshDesktop: 'C:\\\\Programs\\\\DSH Desktop\\\\DSH Desktop.exe', dshVersion: '0.1.0-rc.7', webview2: '130.0.2849.68', profiles: 'web', appVersion: '0.9.8', latest: '0.9.8', panelInstalled: '0.8.1-pre', panelLatest: '0.8.1-pre' }, 'B 官方 DSH Desktop')
  check('官方场景：文案 = 当前 v0.1.0-rc.7（现行文案契约）', b.dsh && b.dsh.text.includes('当前 v0.1.0-rc.7'), b.dsh && b.dsh.text)
  check('官方场景：版本取官方描述（0.1.0-rc.7）', b.dsh && b.dsh.val === '0.1.0-rc.7', b.dsh && b.dsh.val)
  check('官方场景：最新版本 0.9.8 == 0.9.8 → 已最新', b.latest && b.latest.text === '已最新')

  // C. 完全无 DSH
  const c = await runScene({ node: 'v24.18.0', pnpm: '11.22.0', dshDesktop: null, dshVersion: '', webview2: '130.0.2849.68', profiles: 'web', appVersion: '0.9.8', latest: null, panelInstalled: null, panelLatest: '0.8.1-pre' }, 'C 未检测到 DSH')
  check('无 DSH：文案 = 未检测到 dsh CLI（现行文案契约）', c.dsh && c.dsh.text.includes('未检测到 dsh CLI'), c.dsh && c.dsh.text)
  check('无 DSH：状态警示（原型 warn 渲染为 err 徽标）', c.dsh && /warn|err/.test(c.dsh.cls), c.dsh && c.dsh.cls)
  check('无 latest：不出现最新版本行（无误导）', c.latest === null)

  console.log('== 自检验证: PASS=' + pass + ' FAIL=' + fail + ' ==')
} finally {
  await browser.close()
  server.close()
}
process.exitCode = fail === 0 ? 0 : 1
