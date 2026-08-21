#!/usr/bin/env node
/**
 * scripts/repack-dseam-tgz.mjs — 重打包 release/embedded/dseam-skillmcp-*.tgz（R-v5-15）
 *
 * 背景：修复若不进入 EXE 内嵌 tgz 就不会随分发包发布。本脚本：
 *   1) 提升 vendor/dseam-skillmcp 版本（0.8.0-pre → 0.8.1-pre，触发面板更新检测）；
 *   2) 用 npm pack（等价 pnpm pack 的标准 tgz；pnpm 为可选项）打包 vendor 目录；
 *   3) 覆盖 release/embedded/ 下旧 tgz，并同步 build-exe.ps1 / Main.cs 的引用。
 *
 * 用法：node scripts/repack-dseam-tgz.mjs
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const vendorDir = join(root, 'vendor', 'dseam-skillmcp')
const pkgFile = join(vendorDir, 'package.json')
const embeddedDir = join(root, 'release', 'embedded')

const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
const oldVersion = pkg.version
const newVersion = '0.8.1-pre'

// 1) 版本提升（幂等：已是目标版本则跳过）
if (oldVersion !== newVersion) {
  pkg.version = newVersion
  writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n')
  console.log(`version: ${oldVersion} -> ${newVersion}`)
} else {
  console.log(`version: 已是 ${newVersion}`)
}

// 2) npm pack（产物为标准 tgz，dsh plugin add 可安装；优先经 npm_execpath 调 npm-cli.js，
// 避免 Windows 下 spawn .cmd 的 EINVAL——本命令串无用户输入，安全）。
// 行尾归一化：Windows autocrlf 检出会把工作区文本改为 CRLF，直接 pack 会把 CRLF 打进
// tgz，导致 Linux CI 解包比对失败（字节不一致）。先在临时副本把所有文本文件归一化为
// LF 再打包——tgz 恒为 LF，check-embedded-tgz.mjs 双侧归一化比对，跨平台稳定。
// 无扩展名文本（LICENSE 等）同样归一化（与 check-embedded-tgz.mjs 的 isTextFile 口径一致）。
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.md', '.json', '.yml', '.yaml', '.txt', '.ps1', '.cs'])
function isTextFile(buf, name) {
  const dot = name.lastIndexOf('.')
  const ext = dot >= 0 ? name.slice(dot) : ''
  if (TEXT_EXT.has(ext)) return true
  if (ext === '') {
    for (let i = 0; i < buf.length; i += 1) {
      if (buf[i] === 0) return false
    }
    return true
  }
  return false
}
function normalizeCrlf(buf, name) {
  if (!isTextFile(buf, name)) return buf
  const text = buf.toString('utf8')
  return text.includes('\r\n') ? Buffer.from(text.replace(/\r\n/g, '\n'), 'utf8') : buf
}
function copyNormalized(src, dst) {
  const entries = readdirSync(src, { withFileTypes: true })
  for (const ent of entries) {
    const s = join(src, ent.name)
    const d = join(dst, ent.name)
    if (ent.isDirectory()) { mkdirSync(d, { recursive: true }); copyNormalized(s, d) }
    else writeFileSync(d, normalizeCrlf(readFileSync(s), ent.name))
  }
}
const staging = mkdtempSync(join(tmpdir(), 'dseam-staging-'))
const tmp = mkdtempSync(join(tmpdir(), 'dseam-pack-'))
try {
  copyNormalized(vendorDir, staging)
  let packOut
  if (process.env.npm_execpath && existsSync(process.env.npm_execpath)) {
    packOut = execFileSync(process.execPath, [process.env.npm_execpath, 'pack', '--pack-destination', tmp], {
      cwd: staging,
      encoding: 'utf8',
    })
  } else {
    const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (existsSync(npmCli)) {
      packOut = execFileSync(process.execPath, [npmCli, 'pack', '--pack-destination', tmp], { cwd: staging, encoding: 'utf8' })
    } else {
      // 最后回退：cmd /c（固定命令串，无注入面）
      packOut = execFileSync('cmd.exe', ['/d', '/s', '/c', `npm pack --pack-destination "${tmp}"`], { cwd: staging, encoding: 'utf8' })
    }
  }
  const tgzName = String(packOut).trim().split('\n').filter(Boolean).pop()
  const packed = join(tmp, tgzName)
  if (!existsSync(packed)) throw new Error(`npm pack 产物缺失：${tgzName}`)

  // 3) 覆盖 embedded（删除旧版本 tgz）
  for (const f of readdirSync(embeddedDir)) {
    if (f.startsWith('dseam-skillmcp-') && f.endsWith('.tgz')) {
      rmSync(join(embeddedDir, f), { force: true })
      console.log(`removed old tgz: ${f}`)
    }
  }
  const target = join(embeddedDir, `dseam-skillmcp-${newVersion}.tgz`)
  copyFileSync(packed, target)
  console.log(`embedded tgz: ${target}`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
  rmSync(staging, { recursive: true, force: true })
}

// 4) 同步引用（build-exe.ps1 内嵌资源路径）
const buildExe = join(root, 'release', 'build-exe.ps1')
let be = readFileSync(buildExe, 'utf8')
if (be.includes(`dseam-skillmcp-${oldVersion}.tgz`)) {
  be = be.replaceAll(`dseam-skillmcp-${oldVersion}.tgz`, `dseam-skillmcp-${newVersion}.tgz`)
  writeFileSync(buildExe, be)
  console.log(`build-exe.ps1: 引用更新为 ${newVersion}`)
}
// Main.cs PANEL_VERSION
const mainCs = join(root, 'release', 'src', 'Main.cs')
let mc = readFileSync(mainCs, 'utf8')
if (mc.includes(`PANEL_VERSION="${oldVersion}"`)) {
  mc = mc.replace(`PANEL_VERSION="${oldVersion}"`, `PANEL_VERSION="${newVersion}"`)
  writeFileSync(mainCs, mc)
  console.log(`Main.cs: PANEL_VERSION 更新为 ${newVersion}`)
}
console.log('done')
