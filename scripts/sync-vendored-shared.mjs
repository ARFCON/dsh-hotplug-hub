#!/usr/bin/env node
/**
 * scripts/sync-vendored-shared.mjs — 将 packages/shared-core 运行时文件字节复制到
 * 分发产物的 vendor-shared/ 目录（hotplug / memory-hub / dseam-skillmcp），随 git
 * 提交，安装/打包自动携带。
 *
 * 背景（R-v5-1）：hotplug / memory-hub / dseam 经 link 安装或 GitHub tgz 分发时
 * 不存在 workspace 解析，无法 import npm 包 @dsh/shared-core；因此以相对路径
 * `../vendor-shared/...` 消费字节一致的副本。CI 由 scripts/check-vendored-shared.mjs
 * 对同步集逐文件 sha256 断言零漂移。
 *
 * 同步集 = shared-core 运行时文件（test/ 与 vitest.config.js 属开发资产，
 * 不进分发副本——避免 `node --test` 自动发现无 vitest 的测试文件而误报）。
 */
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const src = join(root, 'packages', 'shared-core')

// 开发资产/缓存（不同步进分发副本）：
//   - test/ 与 vitest.config.js：开发资产，避免 `node --test` 自动发现误报；
//   - node_modules：工具缓存（vitest 的 .vite/ 等）可能落在包目录下，绝不可进分发产物；
//   - coverage：覆盖率报告输出目录（vitest 默认 reportsDirectory），同样属开发资产。
const EXCLUDE = new Set(['test', 'vitest.config.js', 'node_modules', 'coverage'])

function copyRuntime(dir, target) {
  mkdirSync(target, { recursive: true })
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE.has(ent.name)) continue
    const s = join(dir, ent.name)
    const d = join(target, ent.name)
    if (ent.isDirectory()) copyRuntime(s, d)
    else cpSync(s, d)
  }
}

const targets = [
  join(root, 'dsh-hotplug-hub', 'vendor-shared'),
  join(root, 'dsh-hotplug-hub', 'dsh-memory-hub', 'vendor-shared'),
  join(root, 'vendor', 'dseam-skillmcp', 'vendor-shared'),
]

for (const target of targets) {
  rmSync(target, { recursive: true, force: true })
  copyRuntime(src, target)
  console.log(`synced: ${src} -> ${target}`)
}
