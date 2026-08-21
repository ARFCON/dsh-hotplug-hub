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
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
// 避免 Windows 下 spawn .cmd 的 EINVAL——本命令串无用户输入，安全）
const tmp = mkdtempSync(join(tmpdir(), 'dseam-pack-'))
try {
  let packOut
  if (process.env.npm_execpath && existsSync(process.env.npm_execpath)) {
    packOut = execFileSync(process.execPath, [process.env.npm_execpath, 'pack', '--pack-destination', tmp], {
      cwd: vendorDir,
      encoding: 'utf8',
    })
  } else {
    const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (existsSync(npmCli)) {
      packOut = execFileSync(process.execPath, [npmCli, 'pack', '--pack-destination', tmp], { cwd: vendorDir, encoding: 'utf8' })
    } else {
      // 最后回退：cmd /c（固定命令串，无注入面）
      packOut = execFileSync('cmd.exe', ['/d', '/s', '/c', `npm pack --pack-destination "${tmp}"`], { cwd: vendorDir, encoding: 'utf8' })
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
