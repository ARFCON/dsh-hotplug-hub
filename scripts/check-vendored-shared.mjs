#!/usr/bin/env node
/**
 * scripts/check-vendored-shared.mjs — CI 字节一致性断言（铁律 B / R-v5-1）：
 * vendor-shared/ 与 packages/shared-core/ 逐文件 sha256 一致（零漂移）；
 * 并断言白名单外无 shared 副本（零散复制）。
 *
 * 退出码：0=一致；1=不一致（输出差异清单）。
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const src = join(root, 'packages', 'shared-core')

const targets = [
  join(root, 'dsh-hotplug-hub', 'vendor-shared'),
  join(root, 'dsh-hotplug-hub', 'dsh-memory-hub', 'vendor-shared'),
  join(root, 'vendor', 'dseam-skillmcp', 'vendor-shared'),
]

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

let failed = false
// 开发资产（不同步进分发副本，与 sync-vendored-shared.mjs 保持一致）
const EXCLUDE = new Set(['test', 'vitest.config.js', 'node_modules', 'coverage'])
const srcFiles = walk(src, '', []).filter((f) => !EXCLUDE.has(f.split('/')[0])).sort()

for (const target of targets) {
  if (!existsSync(target)) {
    console.error(`FAIL: 缺少 vendor-shared 副本：${target}`)
    failed = true
    continue
  }
  const targetFiles = walk(target, '', []).sort()
  const missing = srcFiles.filter((f) => !targetFiles.includes(f))
  const extra = targetFiles.filter((f) => !srcFiles.includes(f))
  for (const f of missing) {
    console.error(`FAIL: ${target} 缺少文件：${f}`)
    failed = true
  }
  for (const f of extra) {
    console.error(`FAIL: ${target} 含多余文件：${f}`)
    failed = true
  }
  for (const f of srcFiles) {
    if (!targetFiles.includes(f)) continue
    const a = sha256(join(src, f))
    const b = sha256(join(target, f))
    if (a !== b) {
      console.error(`FAIL: ${target}/${f} 与 shared-core 不一致`)
      failed = true
    }
  }
  if (!failed) console.log(`OK: ${target} 与 shared-core 逐文件字节一致（${srcFiles.length} 文件）`)
}

// 白名单外零副本：检查消费方源码目录是否存在对 shared 逻辑的重复内联
// （仅做结构级卫生检查：vendor-shared 之外不得 import/require shared-core 包名）
const consumerDirs = [
  join(root, 'dsh-hotplug-hub', 'lib'),
  join(root, 'dsh-hotplug-hub', 'dsh-memory-hub', 'lib'),
  join(root, 'vendor', 'dseam-skillmcp', 'lib'),
]
const forbiddenRef = /(?:from\s*['"]|require\(\s*['"])@dsh\/shared-core/
for (const dir of consumerDirs) {
  for (const f of walk(dir, '', [])) {
    if (!f.endsWith('.js') && !f.endsWith('.mjs')) continue
    const text = readFileSync(join(dir, f), 'utf8')
    if (forbiddenRef.test(text)) {
      console.error(`FAIL: ${relative(root, join(dir, f))} 直接引用了 @dsh/shared-core（应使用 ../vendor-shared 相对路径）`)
      failed = true
    }
  }
}

if (failed) {
  console.error('vendor-shared 一致性检查失败')
  process.exit(1)
}
console.log('vendor-shared 一致性检查通过')
