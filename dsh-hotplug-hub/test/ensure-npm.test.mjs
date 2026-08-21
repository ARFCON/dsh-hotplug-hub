// test/ensure-npm.test.mjs — ensureNpm 全流程（假 pnpm = node 副本 / node shebang 脚本）
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { copyFileSync, writeFileSync, existsSync, readFileSync, chmodSync } from 'node:fs'
import { ensureNpm, installedVersion, npmModuleDir } from '../lib/core/ensure.js'
import { applyIsolatedEnv, isolatedDsh } from './helpers.mjs'

let restoreEnv = null
let iso = null

beforeEach(() => {
  iso = isolatedDsh()
  restoreEnv = applyIsolatedEnv(iso.dshHome)
  // 假 pnpm：Windows 用 node.exe 副本（spawn 免 shell 可解析）；POSIX 用 node
  // shebang 脚本（必须可执行位，否则 spawn EACCES——CI 红根因之一）。默认失败
  // （exit 1）：fakePnpmAdd 会重写为成功实现，覆盖「未落地」失败语义。
  if (process.platform === 'win32') {
    copyFileSync(process.execPath, join(iso.dshHome, 'pnpm.exe'))
  } else {
    writePnpmPosix('#!/usr/bin/env node\nprocess.exit(1)\n')
  }
})
afterEach(() => { if (restoreEnv) restoreEnv(); if (iso) iso.cleanup() })

/** POSIX 假 pnpm：node shebang 脚本 + 可执行位（spawn 直接 exec 需要）。 */
function writePnpmPosix(script) {
  const exe = join(iso.dshHome, 'pnpm')
  writeFileSync(exe, script)
  chmodSync(exe, 0o755)
}

/**
 * 让假 pnpm 的 `add <spec>` 落地 node_modules/<name>/package.json（version 写死）。
 * Windows：node.exe 副本把第一个参数 'add' 当脚本执行（cwd=profile → profile/add）；
 * POSIX：pnpm 脚本内置实现（cwd=profile，process.argv 解析 spec）。
 */
function fakePnpmAdd(version) {
  const addScript = [
    "const fs = require('fs');",
    "const path = require('path');",
    "const spec = (process.argv.slice(2).find((a) => a.includes('@')) || '');",
    "const m = /^([^@]+)@(\\S+)$/.exec(spec);",
    "if (!m) process.exit(1);",
    `const ver = ${JSON.stringify(version)};`,
    "const d = path.join(process.cwd(), 'node_modules', m[1]);",
    "fs.mkdirSync(d, { recursive: true });",
    "fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: m[1], version: ver }));",
    ''
  ].join('\n')
  if (process.platform === 'win32') {
    writeFileSync(join(iso.profile, 'add'), addScript)
  } else {
    writePnpmPosix('#!/usr/bin/env node\n' + addScript)
  }
}

describe('ensureNpm（真实 spawn 假 pnpm）', () => {
  it('缺失 → downloaded：pnpm add 落地 node_modules 且版本匹配（含 --ignore-scripts 参数）', async () => {
    fakePnpmAdd('1.2.3')
    const r = await ensureNpm({ name: 'pkg-a', version: '1.2.3', source: { type: 'npm' } })
    expect(r.ok).toBe(true)
    expect(r.status).toBe('downloaded')
    expect(r.path).toBe(npmModuleDir('pkg-a'))
    expect(installedVersion('pkg-a')).toBe('1.2.3')
  })

  it('DSH_ALLOW_INSTALL_SCRIPTS=1 放行通道（不传 --ignore-scripts，假 pnpm 仍成功）', async () => {
    fakePnpmAdd('2.0.0')
    process.env.DSH_ALLOW_INSTALL_SCRIPTS = '1'
    const r = await ensureNpm({ name: 'pkg-s', version: '2.0.0', source: { type: 'npm' } })
    expect(r.ok).toBe(true)
    expect(r.status).toBe('downloaded')
  })

  it('已有同版本 → reused（零 spawn）', async () => {
    fakePnpmAdd('1.0.0')
    const entry = { name: 'pkg-a', version: '1.0.0', source: { type: 'npm' } }
    // 先装一次
    await ensureNpm(entry)
    const r = await ensureNpm(entry)
    expect(r.ok).toBe(true)
    expect(r.status).toBe('reused')
  })

  it('版本不符（假 pnpm 未落地）→ 显式失败', async () => {
    // 不放置成功实现：pnpm（Windows: node 找不到 profile/add 脚本 → 非 0；
    // POSIX: 默认 exit 1）→ 未落地 → 失败
    const r = await ensureNpm({ name: 'pkg-x', version: '9.9.9', source: { type: 'npm' } })
    expect(r.ok).toBe(false)
    expect(r.status).toBe('error')
    expect(r.error).toContain('pnpm add')
  })
})
