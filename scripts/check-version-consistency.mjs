#!/usr/bin/env node
/**
 * scripts/check-version-consistency.mjs — 版本号单一真源守卫（v1.1 · PC18）
 *
 * 版本号此前散落四处、靠人工同步：
 *   ① package.json（真源）
 *   ② release/src/Main.cs 的 APP_VERSION
 *   ③ release/src/Setup.cs 的 AppVersion 与标题文案
 *   ④ scripts/build-release-packages.mjs（现已改为读 ①，不再独立维护）
 *
 * 本脚本断言 ①②③ 一致（build-release-packages.mjs 已改为读 package.json，④ 随 ①）。
 * 任一不一致 → 非零退出。供 CI 与 check-before-upload.ps1 调用。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const failed = []

function read(p) {
  return readFileSync(join(root, p), 'utf8')
}

// ① 真源
const pkgVersion = JSON.parse(read('package.json')).version
if (!/^\d+\.\d+\.\d+/.test(String(pkgVersion))) {
  console.error('FAIL package.json version 非法: ' + pkgVersion)
  process.exit(1)
}

// ② Main.cs APP_VERSION
const mainCs = read('release/src/Main.cs')
const mainMatch = mainCs.match(/private const string APP_VERSION = "([^"]+)"/)
if (!mainMatch) {
  failed.push('release/src/Main.cs 找不到 APP_VERSION 常量')
} else if (mainMatch[1] !== pkgVersion) {
  failed.push(`Main.cs APP_VERSION=${mainMatch[1]} ≠ package.json ${pkgVersion}`)
}

// ③ Setup.cs AppVersion + 标题
const setupCs = read('release/src/Setup.cs')
const setupMatch = setupCs.match(/private const string AppVersion = "([^"]+)"/)
if (!setupMatch) {
  failed.push('release/src/Setup.cs 找不到 AppVersion 常量')
} else if (setupMatch[1] !== pkgVersion) {
  failed.push(`Setup.cs AppVersion=${setupMatch[1]} ≠ package.json ${pkgVersion}`)
}
const setupTitleCount = (setupCs.match(new RegExp('v' + pkgVersion.replace(/\./g, '\\.'), 'g')) || []).length
if (setupTitleCount < 2) {
  failed.push('Setup.cs 标题/主标签未使用 v' + pkgVersion + '（出现 ' + setupTitleCount + ' 次，应 ≥2）')
}

// ④ build-release-packages.mjs 必须从 package.json 读版本（不再硬编码）
const brp = read('scripts/build-release-packages.mjs')
if (!brp.includes("readFileSync(join(root, 'package.json'), 'utf8')).version")) {
  failed.push('scripts/build-release-packages.mjs 未从 package.json 读取版本号')
}
if (/const version = '\d+\.\d+\.\d+'/.test(brp)) {
  failed.push('scripts/build-release-packages.mjs 仍存在硬编码版本号')
}

// ⑤ installer/Setup.cs 的 ARP DisplayVersion（复审风险-9：第五处硬编码纳入守卫）
const installerSetup = read('installer/Setup.cs')
const installerMatch = installerSetup.match(/SetValue\("DisplayVersion", "([^"]+)"/)
if (!installerMatch) {
  failed.push('installer/Setup.cs 找不到 ARP DisplayVersion 写入')
} else if (installerMatch[1] !== pkgVersion) {
  failed.push(`installer/Setup.cs DisplayVersion=${installerMatch[1]} ≠ package.json ${pkgVersion}`)
}

if (failed.length > 0) {
  console.error('版本一致性检查失败：')
  for (const f of failed) console.error('  - ' + f)
  process.exit(1)
}
console.log('OK: 版本号四处一致 = v' + pkgVersion)
