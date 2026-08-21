#!/usr/bin/env node
/**
 * scripts/check-embedded-tgz.mjs — CI 断言：embedded dseam tgz 与 vendor 源码一致（R-v5-15）
 *
 * 解包 release/embedded/dseam-skillmcp-*.tgz，与 vendor/dseam-skillmcp 按「files 字段
 * 声明的发布集」逐文件字节比对（排除 node_modules / test / 构建产物）。
 * 退出码：0=一致；1=不一致。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const vendorDir = join(root, 'vendor', 'dseam-skillmcp')
const embeddedDir = join(root, 'release', 'embedded')

const tgz = readdirSync(embeddedDir).find((f) => f.startsWith('dseam-skillmcp-') && f.endsWith('.tgz'))
if (!tgz) {
  console.error('FAIL: release/embedded 下无 dseam-skillmcp-*.tgz')
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(join(vendorDir, 'package.json'), 'utf8'))
const filesField = Array.isArray(pkg.files) ? pkg.files : ['lib', 'vendor-shared', 'assets', 'README.md', 'README.en.md', 'LICENSE', 'cordis.patch.yml', 'package.json']
if (!filesField.includes('package.json')) filesField.push('package.json')

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function walk(dir, base, out) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name)
    const rel = base ? `${base}/${ent.name}` : ent.name
    if (ent.isDirectory()) walk(p, rel, out)
    else out.push(rel)
  }
  return out
}

// 按 files 字段枚举期望的发布文件集
const expected = []
for (const entry of filesField) {
  const abs = join(vendorDir, entry)
  if (!existsSync(abs)) continue
  if (statSync(abs).isDirectory()) walk(abs, entry.replace(/\/$/, ''), expected)
  else expected.push(entry.replace(/\/$/, ''))
}

// 解包 tgz（Windows 用 System32 的 bsdtar——git-bash 的 GNU tar 会遮蔽且参数处理不同）
const tarBin = process.platform === 'win32'
  ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  : 'tar'
const tmp = mkdtempSync(join(tmpdir(), 'dseam-check-'))
let failed = false
try {
  execFileSync(tarBin, ['-xf', join(embeddedDir, tgz), '-C', tmp], { stdio: 'ignore' })
  // npm pack 的 tgz 含顶层 package/ 目录
  const entries = readdirSync(tmp)
  const extractRoot = entries.length === 1 ? join(tmp, entries[0]) : tmp
  const packedFiles = walk(extractRoot, '', []).filter((f) => !f.endsWith('.tgz'))
  const missing = expected.filter((f) => !packedFiles.includes(f))
  const extra = packedFiles.filter((f) => !expected.includes(f))
  for (const f of missing) { console.error(`FAIL: tgz 缺少 ${f}`); failed = true; }
  for (const f of extra) { console.error(`FAIL: tgz 含多余 ${f}`); failed = true; }
  for (const f of expected) {
    if (!packedFiles.includes(f)) continue
    const a = sha256(join(vendorDir, f))
    const b = sha256(join(extractRoot, f))
    if (a !== b) { console.error(`FAIL: ${f} 与 vendor 源码不一致`); failed = true; }
  }
  if (!failed) console.log(`OK: ${tgz}（${expected.length} 文件）与 vendor 源码逐字节一致`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

if (failed) {
  console.error('embedded tgz 一致性检查失败')
  process.exit(1)
}
