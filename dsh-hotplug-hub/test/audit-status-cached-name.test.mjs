// test/audit-status-cached-name.test.mjs — 审计发现：statusSync 对 npm 插件 cached 判定
// 只比 current === entry.version，未校验 node_modules/<name> 内部 package.json 的 name
// 是否等于 entry.name（而 ensureNpm 的 reused 判定已补 name 校验）→ status 与真实挂载行为不一致。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { copyFileSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { statusSync, importPackSync, previewPack } from '../lib/core/status.js'
import { ensureNpm } from '../lib/core/ensure.js'
import { applyIsolatedEnv, isolatedDsh, samplePack } from './helpers.mjs'

let restoreEnv = null
let iso = null

beforeEach(() => {
  iso = isolatedDsh()
  restoreEnv = applyIsolatedEnv(iso.dshHome)
})
afterEach(() => { if (restoreEnv) restoreEnv(); if (iso) iso.cleanup() })

/** 假 pnpm add：落地 node_modules/<name>/package.json（name=entry.name，version=entry.version）。 */
function fakePnpmAdd() {
  const script = [
    "const fs = require('fs');",
    "const path = require('path');",
    "const spec = (process.argv.slice(2).find((a) => a.includes('@')) || '');",
    "const m = /^([^@]+)@(\\S+)$/.exec(spec);",
    "if (!m) process.exit(1);",
    "const d = path.join(process.cwd(), 'node_modules', m[1]);",
    "fs.mkdirSync(d, { recursive: true });",
    "fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: m[1], version: m[2] }));",
    '',
  ].join('\n')
  if (process.platform === 'win32') {
    copyFileSync(process.execPath, join(iso.dshHome, 'pnpm.exe'))
    writeFileSync(join(iso.profile, 'add'), script)
  } else {
    const exe = join(iso.dshHome, 'pnpm')
    writeFileSync(exe, `#!${process.execPath}\n` + script)
    chmodSync(exe, 0o755)
  }
}

/** 预置 node_modules/pkg-a：包名错误、版本正确。 */
function plantWrongNamePkg() {
  const dir = join(iso.profile, 'node_modules', 'pkg-a')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'evil-trojan', version: '1.0.0' }))
}

describe('statusSync cached 与 ensureNpm reused 的 name 校验不一致（BUG 复现）', () => {
  it('node_modules 包名被篡改但版本吻合：status 报 cached=true，ensureNpm 却判定 replaced（重装）', async () => {
    importPackSync(JSON.stringify(samplePack({ plugins: [
      { id: 'a', name: 'pkg-a', source: { type: 'npm' }, version: '1.0.0', config: {} },
    ] })))
    plantWrongNamePkg()

    // BUG 复现：status 只比版本，忽略 name → 报 cached=true（"已就绪"）
    const s = statusSync()
    expect(s.packs[0].plugins[0].cached).toBe(false) // 期望 false（name 不符），实际 true

    // 对照组：ensureNpm（真实挂载路径）已补 name 校验 → 判定 replaced（触发重装）
    fakePnpmAdd()
    const r = await ensureNpm({ name: 'pkg-a', version: '1.0.0', source: { type: 'npm' } })
    expect(r.status).toBe('replaced') // ensureNpm 正确识别串包并重装
  })

  it('previewPack 的 npm action 同样只比版本（同源不一致，作扩展证据）', async () => {
    importPackSync(JSON.stringify(samplePack({ plugins: [
      { id: 'a', name: 'pkg-a', source: { type: 'npm' }, version: '1.0.0', config: {} },
    ] })))
    plantWrongNamePkg()
    const prev = await previewPack('pack.test')
    // BUG：preview 报 reused（"已有 pkg-a@1.0.0"），但 ensureNpm 会重装
    expect(prev.refs[0].action).toBe('download') // 期望 download，实际 reused
  })
})
