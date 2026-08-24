// test/ensure-github.test.mjs — github 安装通道深覆盖：ensureGithub / downloadZip /
// ensureEntry 分派 + mountPack（github 源）端到端。全程假 curl/tar（DSH_CURL_BIN /
// DSH_TAR_BIN 指名 → 隔离 PATH 里的 .cmd（win）/ shebang 脚本（posix）），零真实网络。
//
// 关键时序：CURL_BIN/TAR_BIN 是 paths.js 的模块级常量（import 时求值），必须在
// 动态 import lib/core/ensure.js 之前写入 env（ESM 静态 import 会提升到赋值之前）。
process.env.DSH_CURL_BIN = 'dsh-fake-curl'
process.env.DSH_TAR_BIN = 'dsh-fake-tar'
// 注意：所有 lib/* 依赖必须动态 import——ESM 静态 import 会提升到上面的 env 赋值
// 之前求值 paths.js，导致 CURL_BIN/TAR_BIN 捕获默认值（curl.exe/tar.exe）。
const { ensureGithub, downloadZip, ensureEntry, githubZipUrls, storeDirOf, storeKeySegment } = await import('../lib/core/ensure.js')
const { mountPack, unmountPack } = await import('../lib/core/patch.js')
const { importPackSync } = await import('../lib/core/status.js')
const { GITHUB_MIRRORS, patchPath } = await import('../lib/core/paths.js')
const { readJson } = await import('../lib/core/state.js')
// 常量已捕获，立即还原 env——避免泄漏到同 worker 里后续执行的其它测试文件
// （vitest 隔离模块注册表但不隔离 process.env）。审查修复：还原为先前的值而非
// 直接 delete（万一宿主本来就设了这两个变量）。
const __prevCurlBin = process.env.DSH_CURL_BIN
const __prevTarBin = process.env.DSH_TAR_BIN
if (__prevCurlBin === undefined) delete process.env.DSH_CURL_BIN
else process.env.DSH_CURL_BIN = __prevCurlBin
if (__prevTarBin === undefined) delete process.env.DSH_TAR_BIN
else process.env.DSH_TAR_BIN = __prevTarBin

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync,
} from 'node:fs'
import { applyIsolatedEnv, isolatedDsh } from './helpers.mjs'

let restoreEnv = null
let iso = null
let curlLog = ''

beforeEach(() => {
  iso = isolatedDsh()
  restoreEnv = applyIsolatedEnv(iso.dshHome)
  writeFakes()
  curlLog = join(iso.dshHome, 'fake-curl.log')
  process.env.FAKE_CURL_LOG = curlLog
})
afterEach(() => {
  // 清掉本文件注入的 FAKE_* 控制变量，防止串到后续用例
  for (const key of ['FAKE_CURL_LOG', 'FAKE_CURL_MODE', 'FAKE_TAR_SRC', 'FAKE_TAR_MODE', 'FAKE_TAR_NAME', 'FAKE_TAR_ESCAPE']) {
    delete process.env[key]
  }
  if (restoreEnv) restoreEnv()
  if (iso) iso.cleanup()
})

// ---------- 假二进制（curl / tar） ----------

/** 假 curl：按 URL 分支（'/fail' 子串 → curl -f 的 exit 22；FAKE_CURL_MODE
 *  'fail-official' → 仅官方直连失败，镜像成功——测镜像回退），每次调用把 URL
 *  追加进 FAKE_CURL_LOG（供用例断言尝试次数与顺序）。 */
const FAKE_CURL_IMPL = [
  "const fs = require('fs')",
  "const args = process.argv.slice(2)",
  "const url = args[args.length - 1] || ''",
  "const outIdx = args.indexOf('-o')",
  "const out = outIdx >= 0 ? args[outIdx + 1] : null",
  "if (process.env.FAKE_CURL_LOG) { try { fs.appendFileSync(process.env.FAKE_CURL_LOG, url + '\\n') } catch {} }",
  "let fail = false",
  "if (url.includes('/fail')) fail = true",
  "if (process.env.FAKE_CURL_MODE === 'fail-official' && url.startsWith('https://codeload.github.com/')) fail = true",
  "if (process.env.FAKE_CURL_MODE === 'fail-all') fail = true",
  "if (fail) { process.stderr.write('curl: (22) The requested URL returned error: 404'); process.exit(22) }",
  "if (out) fs.writeFileSync(out, 'PK-fake-zip\\n')",
  'process.exit(0)',
  '',
].join('\n')

/** 假 tar：-C 目录里物化 FAKE_TAR_SRC 整树（模拟 GitHub zip 单根解包）；
 *  FAKE_TAR_MODE 分支：fail（exit 1）/ slip（越界符号链接）/ multi（多根 +
 *  顶层 package.json）/ pkgdir（package.json 是目录的畸形树）。 */
const FAKE_TAR_IMPL = [
  "const fs = require('fs')",
  "const path = require('path')",
  "const args = process.argv.slice(2)",
  "const cIdx = args.indexOf('-C')",
  "const dir = cIdx >= 0 ? args[cIdx + 1] : null",
  "const mode = process.env.FAKE_TAR_MODE || 'copy'",
  "try {",
  "  if (mode === 'fail') { process.stderr.write('tar: Unrecognized archive format'); process.exit(1) }",
  "  if (!dir) process.exit(1)",
  "  if (mode === 'slip') {",
  "    const esc = process.env.FAKE_TAR_ESCAPE || path.join(path.dirname(path.resolve(dir)), 'esc-target')",
  "    fs.mkdirSync(esc, { recursive: true })",
  "    fs.writeFileSync(path.join(esc, 'secret.txt'), 'outside')",
  "    fs.symlinkSync(esc, path.join(dir, 'escape-link'), 'junction')",
  "    process.exit(0)",
  "  }",
  "  if (mode === 'multi') {",
  "    fs.cpSync(process.env.FAKE_TAR_SRC, dir, { recursive: true })",
  "    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: process.env.FAKE_TAR_NAME || 'pkg-m', version: '1.0.0' }))",
  "    process.exit(0)",
  "  }",
  "  if (mode === 'pkgdir') {",
  "    fs.mkdirSync(path.join(dir, 'weird-root', 'package.json'), { recursive: true })",
  "    fs.writeFileSync(path.join(dir, 'weird-root', 'placeholder.txt'), 'x')",
  "    process.exit(0)",
  "  }",
  "  fs.cpSync(process.env.FAKE_TAR_SRC, dir, { recursive: true })",
  '  process.exit(0)',
  '} catch (e) { process.stderr.write(String(e && e.message ? e.message : e)); process.exit(1) }',
  '',
].join('\n')

/** 写入假 curl/tar：实现体（.cjs，tmp 下无 package.json 作用域 → CommonJS）+
 *  平台包装（win：.cmd 经 ComSpec 解析；posix：绝对路径 shebang + 可执行位）。 */
function writeFakes() {
  writeFileSync(join(iso.dshHome, 'fake-curl.impl.cjs'), FAKE_CURL_IMPL)
  writeFileSync(join(iso.dshHome, 'fake-tar.impl.cjs'), FAKE_TAR_IMPL)
  if (process.platform === 'win32') {
    // cmd 包装：%~dp0 = .cmd 所在目录（即隔离 PATH 目录）；node 用绝对路径
    writeFileSync(join(iso.dshHome, 'dsh-fake-curl.cmd'), `@"${process.execPath}" "%~dp0fake-curl.impl.cjs" %*\r\n`)
    writeFileSync(join(iso.dshHome, 'dsh-fake-tar.cmd'), `@"${process.execPath}" "%~dp0fake-tar.impl.cjs" %*\r\n`)
  } else {
    // shebang 必须 process.execPath 绝对路径（隔离 PATH 无 node）；需可执行位
    for (const [name, impl] of [['dsh-fake-curl', 'fake-curl.impl.cjs'], ['dsh-fake-tar', 'fake-tar.impl.cjs']]) {
      const exe = join(iso.dshHome, name)
      writeFileSync(exe, `#!${process.execPath}\nrequire(${JSON.stringify(join(iso.dshHome, impl))});\n`)
      chmodSync(exe, 0o755)
    }
  }
}

// ---------- 用例小工具 ----------

/** github 插件条目。 */
const ghEntry = (name, repo, ref = 'v1') => ({ id: 'g1', name, source: { type: 'github', repo, ref }, config: {} })

/** 标准解包夹具：单根目录 `<末段名>-a1b2c3`（模拟 GitHub zip 的 repo-ref 根，
 *  scoped 名取末段作目录名——zip 单根外壳不含 '/'），含 package.json / index.js /
 *  lib/util.js；设置 FAKE_TAR_SRC。返回夹具根路径。 */
function stdFixture(innerName = 'pkg-g') {
  const src = join(iso.dshHome, 'fixture')
  const root = join(src, `${innerName.split('/').pop()}-a1b2c3`)
  mkdirSync(join(root, 'lib'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: innerName, version: '1.0.0', main: 'index.js' }))
  writeFileSync(join(root, 'index.js'), 'module.exports = 1\n')
  writeFileSync(join(root, 'lib', 'util.js'), 'module.exports = 2\n')
  process.env.FAKE_TAR_SRC = src
  return root
}

/** 假 curl 的调用记录（URL 列表；未调用 → 空数组）。 */
function curlCalls() {
  try { return readFileSync(curlLog, 'utf8').split('\n').filter((line) => line !== '') } catch { return [] }
}

// ---------- downloadZip（真实 runCli → 真实 spawn 假 curl） ----------

describe('downloadZip（真实 spawn 假 curl）', () => {
  it('ok URL → true 且 zip 落盘（-o 目标 + URL 末参被假 curl 正确解析）', async () => {
    const zip = join(iso.dshHome, 'dl.zip')
    const url = 'https://codeload.github.com/o/ok-repo/zip/refs/heads/v1'
    expect(await downloadZip(url, zip)).toBe(true)
    expect(existsSync(zip)).toBe(true)
    expect(readFileSync(zip, 'utf8')).toBe('PK-fake-zip\n')
    expect(curlCalls()).toEqual([url])
  })

  it('fail URL → false 且不落盘（curl -f 语义：HTTP 错误 exit 22）', async () => {
    const zip = join(iso.dshHome, 'dl.zip')
    expect(await downloadZip('https://codeload.github.com/o/fail-repo/zip/refs/heads/v1', zip)).toBe(false)
    expect(existsSync(zip)).toBe(false)
    expect(curlCalls()).toHaveLength(1)
  })

  it('目标已有陈旧 zip + fail URL → 仍 false（exit 非 0 一票否决，不吃陈旧文件）', async () => {
    const zip = join(iso.dshHome, 'dl.zip')
    writeFileSync(zip, 'STALE')
    expect(await downloadZip('https://codeload.github.com/o/fail-repo/zip/refs/heads/v1', zip)).toBe(false)
    expect(readFileSync(zip, 'utf8')).toBe('STALE')
  })
})

// ---------- githubZipUrls ----------

describe('githubZipUrls', () => {
  it('官方 heads/tags 打头 + 每镜像两条（heads 后 tags），总数 = 2 + 2×镜像数', () => {
    const urls = githubZipUrls('o/r', 'v1')
    expect(urls).toHaveLength(2 + GITHUB_MIRRORS.length * 2)
    expect(urls[0]).toBe('https://codeload.github.com/o/r/zip/refs/heads/v1')
    expect(urls[1]).toBe('https://codeload.github.com/o/r/zip/refs/tags/v1')
    expect(urls[2]).toBe(GITHUB_MIRRORS[0] + urls[0])
    expect(urls[3]).toBe(GITHUB_MIRRORS[0] + urls[1])
    expect(new Set(urls).size).toBe(urls.length) // 无重复
  })

  it('镜像 URL = 镜像前缀拼接完整官方 URL（逐条校验，不漏一个镜像）', () => {
    const urls = githubZipUrls('o/r', 'v1')
    const direct = new Set([urls[0], urls[1]])
    for (let i = 2; i < urls.length; i += 2) {
      const mirror = GITHUB_MIRRORS[(i - 2) / 2]
      expect(urls[i]).toBe(mirror + urls[0])
      expect(urls[i + 1]).toBe(mirror + urls[1])
      expect(direct.has(urls[i])).toBe(false)
    }
  })

  it('含 / 的 ref 在 URL 中原样出现（%2F 编码只发生在 store 键，不进 URL）', () => {
    const urls = githubZipUrls('o/r', 'feature/x')
    expect(urls[0].endsWith('/refs/heads/feature/x')).toBe(true)
    expect(urls[1].endsWith('/refs/tags/feature/x')).toBe(true)
    for (const url of urls) expect(url.includes('%2F')).toBe(false)
    expect(urls[2].endsWith('/refs/heads/feature/x')).toBe(true)
  })
})

// ---------- storeKeySegment / storeDirOf ----------

describe('storeKeySegment / storeDirOf（store 键单段化）', () => {
  it('storeKeySegment：/ → %2F；空/缺省 → 空串；不同输入不碰撞', () => {
    expect(storeKeySegment('a/b')).toBe('a%2Fb')
    expect(storeKeySegment('feature/x')).toBe('feature%2Fx')
    expect(storeKeySegment('feature')).toBe('feature')
    expect(storeKeySegment('@scope/pkg')).toBe('@scope%2Fpkg')
    expect(storeKeySegment('')).toBe('')
    expect(storeKeySegment(null)).toBe('')
    expect(storeKeySegment(undefined)).toBe('')
    // 可区分性：'a/b' 与 'ab' 不得映射到同一段
    expect(storeKeySegment('a/b')).not.toBe(storeKeySegment('ab'))
    // ref 字符集 [0-9A-Za-z._-/] 不含 '%'，'a%2Fb' 字面量不是合法 ref → 无二次编码碰撞
    expect(storeKeySegment('a/b')).not.toBe(storeKeySegment('a%252Fb'))
  })

  it('storeDirOf：scoped 名 + 含 / 的 ref → 单段 store 键', () => {
    const d = storeDirOf({ name: '@scope/pkg', source: { type: 'github', ref: 'feature/x' } })
    expect(d).toBe(join(iso.dshHome, 'hotplug-store', '@scope%2Fpkg@feature%2Fx'))
    // 末段不含路径分隔符（真正的单段，junction/cpSync 安全）
    const seg = d.split(/[\\/]/).pop()
    expect(seg).toBe('@scope%2Fpkg@feature%2Fx')
  })

  it('storeDirOf 按 source.type 分派：path 原样 / npm 走 profile node_modules', () => {
    expect(storeDirOf({ name: 'n', source: { type: 'path', path: 'C:/x' } })).toBe('C:/x')
    expect(storeDirOf({ name: 'n', source: { type: 'npm' } })).toBe(join(iso.profile, 'node_modules', 'n'))
    expect(storeDirOf({ name: 'n', source: { type: 'github', ref: 'main' } })).toBe(join(iso.dshHome, 'hotplug-store', 'n@main'))
  })
})

// ---------- ensureGithub 主流程 ----------

describe('ensureGithub（真实 spawn 假 curl + 假 tar）', () => {
  it('首次下载：downloaded + 落到 hotplug-store/<name>@<ref>，整树（含子目录）拷贝', async () => {
    stdFixture('pkg-g')
    const entry = ghEntry('pkg-g', 'acme/ok-repo', 'v1')
    const r = await ensureGithub(entry)
    expect(r.ok).toBe(true)
    expect(r.status).toBe('downloaded')
    expect(r.path).toBe(storeDirOf(entry))
    expect(r.path).toBe(join(iso.dshHome, 'hotplug-store', 'pkg-g@v1'))
    expect(r.detail).toContain('acme/ok-repo@v1')
    // store 内 package.json 内部包名一致 + index.js / lib/util.js 递归拷贝
    expect(readJson(join(r.path, 'package.json'))).toMatchObject({ name: 'pkg-g', version: '1.0.0' })
    expect(readFileSync(join(r.path, 'index.js'), 'utf8')).toBe('module.exports = 1\n')
    expect(existsSync(join(r.path, 'lib', 'util.js'))).toBe(true)
    // 夹具的 zip 单根外壳目录名不得进入 store（拷的是根内容，不是根目录自身）
    expect(existsSync(join(r.path, 'pkg-g-a1b2c3'))).toBe(false)
    // 首试即中：官方 heads 一次成功，零镜像尝试
    expect(curlCalls()).toEqual(['https://codeload.github.com/acme/ok-repo/zip/refs/heads/v1'])
  })

  it('二次调用：reused 且零下载（假 curl 不再被唤起）', async () => {
    stdFixture('pkg-g')
    const entry = ghEntry('pkg-g', 'acme/ok-repo', 'v1')
    await ensureGithub(entry)
    const r = await ensureGithub(entry)
    expect(r.ok).toBe(true)
    expect(r.status).toBe('reused')
    expect(r.detail).toContain('已有 pkg-g@v1')
    expect(curlCalls()).toHaveLength(1) // 只有首次那一行
  })

  it('兄弟 ref 隔离：pkg-g@feature 与 pkg-g@feature/x 各自独立缓存互不删除', async () => {
    stdFixture('pkg-g')
    const entryX = ghEntry('pkg-g', 'acme/ok-repo', 'feature/x')
    const r1 = await ensureGithub(entryX)
    expect(r1.status).toBe('downloaded')
    expect(r1.path.endsWith('pkg-g@feature%2Fx')).toBe(true)
    // 再下载 ref='feature'（平铺键 pkg-g@feature）→ 不得连带删除 feature/x 的缓存
    const r2 = await ensureGithub(ghEntry('pkg-g', 'acme/ok-repo', 'feature'))
    expect(r2.status).toBe('downloaded')
    expect(existsSync(join(r1.path, 'package.json'))).toBe(true)
    expect(existsSync(join(r1.path, 'index.js'))).toBe(true)
    expect(existsSync(join(r2.path, 'package.json'))).toBe(true)
  })

  it('scoped 插件名 @scope/pkg-g：store 键单段（@scope%2Fpkg-g@v1），可正常下载', async () => {
    stdFixture('@scope/pkg-g')
    const entry = ghEntry('@scope/pkg-g', 'acme/ok-repo', 'v1')
    const r = await ensureGithub(entry)
    expect(r.ok).toBe(true)
    expect(r.status).toBe('downloaded')
    expect(r.path).toBe(join(iso.dshHome, 'hotplug-store', '@scope%2Fpkg-g@v1'))
    expect(readJson(join(r.path, 'package.json')).name).toBe('@scope/pkg-g')
  })

  // ----- reuse 分支的三种「不 reused」形态（均应触发重新下载） -----

  it('store 残留 package.json 内部包名不符 → 不 reused，重新下载覆盖', async () => {
    stdFixture('pkg-g')
    const entry = ghEntry('pkg-g', 'acme/ok-repo', 'v1')
    const dest = storeDirOf(entry)
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, 'package.json'), JSON.stringify({ name: 'evil-trojan' }))
    const r = await ensureGithub(entry)
    expect(r.ok).toBe(true)
    expect(r.status).toBe('downloaded') // 不是 reused
    expect(readJson(join(dest, 'package.json')).name).toBe('pkg-g')
    expect(curlCalls()).toHaveLength(1) // 确实重新下载了一次
  })

  it('store 残留 package.json 是坏 JSON（innerPackageName=null）→ 重新下载', async () => {
    stdFixture('pkg-g')
    const entry = ghEntry('pkg-g', 'acme/ok-repo', 'v1')
    const dest = storeDirOf(entry)
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, 'package.json'), '{not json')
    const r = await ensureGithub(entry)
    expect(r.status).toBe('downloaded')
    expect(readJson(join(dest, 'package.json')).name).toBe('pkg-g')
  })

  it('store 目录存在但缺 package.json → 重新下载', async () => {
    stdFixture('pkg-g')
    const entry = ghEntry('pkg-g', 'acme/ok-repo', 'v1')
    const dest = storeDirOf(entry)
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, 'index.js'), 'stale')
    const r = await ensureGithub(entry)
    expect(r.status).toBe('downloaded')
    expect(readFileSync(join(dest, 'index.js'), 'utf8')).toBe('module.exports = 1\n')
  })

  it('陈旧 store 清理：重下载前 rmSync 整目录，垃圾文件不得残留在新缓存里', async () => {
    stdFixture('pkg-g')
    const entry = ghEntry('pkg-g', 'acme/ok-repo', 'v1')
    const dest = storeDirOf(entry)
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, 'package.json'), JSON.stringify({ name: 'evil-trojan' }))
    writeFileSync(join(dest, 'garbage.txt'), 'old world')
    const r = await ensureGithub(entry)
    expect(r.status).toBe('downloaded')
    expect(existsSync(join(dest, 'garbage.txt'))).toBe(false)
    expect(existsSync(join(dest, 'index.js'))).toBe(true)
  })

  // ----- 下载失败与镜像回退 -----

  it('全部 URL 失败（repo 名含 fail）→ 显式错误，不建 store，尝试官方+全部镜像', async () => {
    stdFixture('pkg-fail')
    const entry = ghEntry('pkg-fail', 'acme/fail-repo', 'v1')
    const r = await ensureGithub(entry)
    expect(r.ok).toBe(false)
    expect(r.status).toBe('error')
    expect(r.error).toContain('下载失败')
    expect(r.error).toContain('acme/fail-repo@v1')
    expect(existsSync(storeDirOf(entry))).toBe(false)
    // 官方 2 条 + 每镜像 2 条全部试过
    expect(curlCalls()).toHaveLength(githubZipUrls('acme/fail-repo', 'v1').length)
  })

  it('镜像回退：官方直连失败 → 第一个镜像命中（尝试顺序官方→镜像，≥2 次）', async () => {
    stdFixture('pkg-g')
    process.env.FAKE_CURL_MODE = 'fail-official' // 仅 https://codeload.github.com/ 直连失败
    const entry = ghEntry('pkg-g', 'acme/ok-repo', 'v1')
    const r = await ensureGithub(entry)
    expect(r.ok).toBe(true)
    expect(r.status).toBe('downloaded')
    const calls = curlCalls()
    expect(calls.length).toBeGreaterThanOrEqual(2)
    // 前两条官方（heads/tags）失败，第三条为首个镜像的 heads URL
    expect(calls[0].startsWith('https://codeload.github.com/')).toBe(true)
    expect(calls[1].startsWith('https://codeload.github.com/')).toBe(true)
    expect(calls[2]).toBe(GITHUB_MIRRORS[0] + 'https://codeload.github.com/acme/ok-repo/zip/refs/heads/v1')
    expect(existsSync(join(storeDirOf(entry), 'package.json'))).toBe(true)
  })

  // ----- 解压与解包安全（M-39） -----

  it('tar 失败（exit 1）→ 解压失败错误，不建 store', async () => {
    stdFixture('pkg-g')
    process.env.FAKE_TAR_MODE = 'fail'
    const entry = ghEntry('pkg-g', 'acme/ok-repo', 'v1')
    const r = await ensureGithub(entry)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('解压失败')
    expect(existsSync(storeDirOf(entry))).toBe(false)
  })

  it('解包含指向根外的符号链接 → 解包内容不安全（M-39 越界拒绝），不建 store', async () => {
    stdFixture('pkg-g')
    process.env.FAKE_TAR_MODE = 'slip'
    process.env.FAKE_TAR_ESCAPE = join(iso.dshHome, 'escape-target') // 真实存在的根外目录
    const entry = ghEntry('pkg-g', 'acme/ok-repo', 'v1')
    const r = await ensureGithub(entry)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('解包内容不安全')
    expect(r.error).toContain('越界')
    expect(existsSync(storeDirOf(entry))).toBe(false)
  })

  it('多根解包（两个顶层目录 + 顶层 package.json）→ root=解包根，正常落 store', async () => {
    // 夹具：A/ 与 B/ 两个顶层目录（无 package.json）；假 tar 额外在 -C 顶层写 package.json
    const src = join(iso.dshHome, 'fixture')
    mkdirSync(join(src, 'A'), { recursive: true })
    mkdirSync(join(src, 'B'), { recursive: true })
    writeFileSync(join(src, 'A', 'a.txt'), 'a')
    writeFileSync(join(src, 'B', 'b.txt'), 'b')
    process.env.FAKE_TAR_SRC = src
    process.env.FAKE_TAR_MODE = 'multi'
    process.env.FAKE_TAR_NAME = 'pkg-m'
    const entry = ghEntry('pkg-m', 'acme/ok-repo', 'v1')
    const r = await ensureGithub(entry)
    expect(r.ok).toBe(true)
    expect(r.status).toBe('downloaded')
    const dest = storeDirOf(entry)
    expect(readJson(join(dest, 'package.json')).name).toBe('pkg-m')
    expect(existsSync(join(dest, 'A', 'a.txt'))).toBe(true)
    expect(existsSync(join(dest, 'B', 'b.txt'))).toBe(true)
  })

  it('多根解包但顶层 package.json 内部包名不符 → 内部包名不一致错误', async () => {
    const src = join(iso.dshHome, 'fixture')
    mkdirSync(join(src, 'A'), { recursive: true })
    writeFileSync(join(src, 'A', 'a.txt'), 'a')
    process.env.FAKE_TAR_SRC = src
    process.env.FAKE_TAR_MODE = 'multi'
    process.env.FAKE_TAR_NAME = 'other-name'
    const entry = ghEntry('pkg-m', 'acme/ok-repo', 'v1')
    const r = await ensureGithub(entry)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('内部包名 other-name 与清单声明 pkg-m 不一致')
    expect(existsSync(storeDirOf(entry))).toBe(false)
  })

  it('单根缺 package.json → 缺少 package.json 错误', async () => {
    const src = join(iso.dshHome, 'fixture')
    const root = join(src, 'bare-root')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'index.js'), 'x')
    process.env.FAKE_TAR_SRC = src
    const entry = ghEntry('pkg-g', 'acme/ok-repo', 'v1')
    const r = await ensureGithub(entry)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('缺少 package.json')
    expect(existsSync(storeDirOf(entry))).toBe(false)
  })

  it('单根 package.json 内部包名不符 → 内部包名不一致错误', async () => {
    const root = stdFixture('other-name')
    const entry = ghEntry('pkg-g', 'acme/ok-repo', 'v1')
    const r = await ensureGithub(entry)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('内部包名 other-name 与清单声明 pkg-g 不一致')
    expect(existsSync(storeDirOf(entry))).toBe(false)
    expect(existsSync(root)).toBe(true) // 夹具不受影响
  })

  it('package.json 是目录（畸形树，innerPackageName=null）→ 内部包名「未知」错误', async () => {
    process.env.FAKE_TAR_SRC = join(iso.dshHome, 'fixture') // pkgdir 模式不读它，但保持契约
    process.env.FAKE_TAR_MODE = 'pkgdir'
    const entry = ghEntry('pkg-w', 'acme/ok-repo', 'v1')
    const r = await ensureGithub(entry)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('内部包名 未知')
    expect(r.error).toContain('pkg-w')
    expect(existsSync(storeDirOf(entry))).toBe(false)
  })

  it('package.json 是坏 JSON（innerPackageName=null）→ 内部包名「未知」错误', async () => {
    const src = join(iso.dshHome, 'fixture')
    const root = join(src, 'bad-json-root')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'package.json'), 'definitely { not json')
    process.env.FAKE_TAR_SRC = src
    const entry = ghEntry('pkg-g', 'acme/ok-repo', 'v1')
    const r = await ensureGithub(entry)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('内部包名 未知 与清单声明 pkg-g 不一致')
  })
})

// ---------- ensureEntry 分派 ----------

describe('ensureEntry 分派', () => {
  it('npm 条目 → ensureNpm 通道：隔离 PATH 无 pnpm → 结构化失败（不抛异常）', async () => {
    const r = await ensureEntry({ name: 'pkg-n', version: '1.0.0', source: { type: 'npm' } })
    expect(r.ok).toBe(false)
    expect(r.status).toBe('error')
    expect(r.error).toContain('pnpm add pkg-n@1.0.0')
  })

  it('path 条目 → ensurePath 通道：合法本地目录 reused（零 curl/tar 唤起）', async () => {
    const src = join(iso.dshHome, 'local-src')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'pkg-local', version: '1.0.0' }))
    const r = await ensureEntry({ name: 'pkg-local', source: { type: 'path', path: src } })
    expect(r.ok).toBe(true)
    expect(r.status).toBe('reused')
    expect(r.path).toBe(src)
    expect(curlCalls()).toHaveLength(0)
  })

  it('github 条目 → ensureGithub 通道：走下载流程落到 hotplug-store', async () => {
    stdFixture('pkg-g')
    const entry = ghEntry('pkg-g', 'acme/ok-repo', 'v1')
    const r = await ensureEntry(entry)
    expect(r.ok).toBe(true)
    expect(r.status).toBe('downloaded')
    expect(r.path).toBe(storeDirOf(entry))
    expect(curlCalls()).toHaveLength(1)
  })
})

// ---------- importPackSync（github 源清单校验通道） ----------

describe('importPackSync（github 插件清单）', () => {
  it('合法 github 源 hotpack → 导入成功并落盘 packs/<id>/hotpack.json', () => {
    const r = importPackSync({
      hotpack: '1.0',
      id: 'pack.gh',
      name: 'GH Pack',
      version: '1.0.0',
      plugins: [{ id: 'g1', name: 'pkg-g', source: { type: 'github', repo: 'acme/ok-repo', ref: 'feature/x' }, config: {} }],
    })
    expect(r.ok).toBe(true)
    expect(r.pack.plugins).toBe(1)
    const saved = readJson(join(iso.dshHome, 'hotplug-hub', 'packs', 'pack.gh', 'hotpack.json'))
    expect(saved.plugins[0].source).toEqual({ type: 'github', repo: 'acme/ok-repo', ref: 'feature/x' })
  })

  it('repo 带 .. 穿越 → vendor-shared 校验拒绝导入', () => {
    const r = importPackSync({
      hotpack: '1.0',
      id: 'pack.gh2',
      name: 'Bad',
      version: '1.0.0',
      plugins: [{ id: 'g1', name: 'pkg-g', source: { type: 'github', repo: 'acme/../evil' }, config: {} }],
    })
    expect(r.ok).toBe(false)
  })
})

// ---------- mountPack / unmountPack（github 源端到端） ----------

describe('mountPack / unmountPack（github 源插件，端到端）', () => {
  /** github-only 包对象（与 parseHotpack 产物同构）。 */
  const ghPack = () => ({
    hotpack: '1.0',
    id: 'pack.gh',
    name: 'GH Pack',
    version: '1.0.0',
    description: 'github source pack',
    tags: ['gh'],
    plugins: [ghEntry('pkg-g', 'acme/ok-repo', 'v1')],
  })

  it('mountPack：下载 → link: 依赖 + node_modules junction + patch 块三件套齐落', async () => {
    stdFixture('pkg-g')
    const pack = ghPack()
    const m = await mountPack(pack)
    expect(m.ok).toBe(true)
    expect(m.restartNeeded).toBe(true)
    expect(m.steps).toHaveLength(1)
    expect(m.steps[0]).toMatchObject({ id: 'g1', name: 'pkg-g', status: 'downloaded' })
    expect(m.steps[0].detail).toContain('acme/ok-repo@v1')
    // manifest：link: 依赖（正斜杠形态的 store 绝对路径）
    const store = storeDirOf(pack.plugins[0])
    const manifest = readJson(join(iso.profile, 'package.json'))
    expect(manifest.dependencies['pkg-g']).toBe(`link:${store.replace(/\\/g, '/')}`)
    // junction：node_modules/pkg-g 指向 store
    const link = join(iso.profile, 'node_modules', 'pkg-g')
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(realpathSync(link)).toBe(realpathSync(store))
    expect(readJson(join(link, 'package.json')).name).toBe('pkg-g')
    // patch 块
    expect(readFileSync(patchPath(), 'utf8')).toContain('## hotplug:pack.gh')
  })

  it('unmountPack：link 依赖 / junction / patch 块三撤，store 缓存保留', async () => {
    stdFixture('pkg-g')
    const pack = ghPack()
    await mountPack(pack)
    const store = storeDirOf(pack.plugins[0])
    const u = await unmountPack(pack)
    expect(u.ok).toBe(true)
    const manifest = readJson(join(iso.profile, 'package.json'))
    expect(manifest.dependencies['pkg-g']).toBeUndefined()
    expect(existsSync(join(iso.profile, 'node_modules', 'pkg-g'))).toBe(false)
    expect(readFileSync(patchPath(), 'utf8')).not.toContain('hotplug:pack.gh')
    // 卸载不删缓存（下次激活 reused）
    expect(existsSync(join(store, 'package.json'))).toBe(true)
  })

  it('unmount 后再 mount：插件 reused（零下载），三件套重新落地', async () => {
    stdFixture('pkg-g')
    const pack = ghPack()
    await mountPack(pack)
    await unmountPack(pack)
    const m = await mountPack(pack)
    expect(m.ok).toBe(true)
    expect(m.steps[0].status).toBe('reused')
    expect(curlCalls()).toHaveLength(1) // 只有最初一次下载
    expect(readJson(join(iso.profile, 'package.json')).dependencies['pkg-g']).toContain('link:')
  })

  it('混合包（path + github 插件）：两个非 npm 插件都建 link/junction', async () => {
    stdFixture('pkg-g')
    const local = join(iso.dshHome, 'local-src')
    mkdirSync(local, { recursive: true })
    writeFileSync(join(local, 'package.json'), JSON.stringify({ name: 'pkg-local', version: '1.0.0' }))
    const pack = {
      hotpack: '1.0', id: 'pack.mix', name: 'Mix', version: '1.0.0', description: '', tags: [],
      plugins: [
        { id: 'p1', name: 'pkg-local', source: { type: 'path', path: local }, config: {} },
        ghEntry('pkg-g', 'acme/ok-repo', 'v1'),
      ],
    }
    const m = await mountPack(pack)
    expect(m.ok).toBe(true)
    expect(m.steps.map((s) => s.status)).toEqual(['reused', 'downloaded'])
    const manifest = readJson(join(iso.profile, 'package.json'))
    expect(manifest.dependencies['pkg-local']).toContain('link:')
    expect(manifest.dependencies['pkg-g']).toContain('link:')
    expect(existsSync(join(iso.profile, 'node_modules', 'pkg-local', 'package.json'))).toBe(true)
    expect(existsSync(join(iso.profile, 'node_modules', 'pkg-g', 'package.json'))).toBe(true)
    expect(readFileSync(patchPath(), 'utf8')).toContain('## hotplug:pack.mix')
  })

  it('github 下载失败 → mountPack 全量回滚（无 link / 无 junction / 无 patch 块）', async () => {
    stdFixture('pkg-fail') // 用不上（下载全失败）
    const pack = {
      hotpack: '1.0', id: 'pack.gh3', name: 'Fail', version: '1.0.0', description: '', tags: [],
      plugins: [ghEntry('pkg-g', 'acme/fail-repo', 'v1')],
    }
    const m = await mountPack(pack)
    expect(m.ok).toBe(false)
    expect(m.error).toContain('下载失败')
    const manifest = readJson(join(iso.profile, 'package.json'))
    expect(manifest.dependencies['pkg-g']).toBeUndefined()
    expect(existsSync(join(iso.profile, 'node_modules', 'pkg-g'))).toBe(false)
    expect(existsSync(patchPath()) ? readFileSync(patchPath(), 'utf8') : '').not.toContain('hotplug:pack.gh3')
  })
})
