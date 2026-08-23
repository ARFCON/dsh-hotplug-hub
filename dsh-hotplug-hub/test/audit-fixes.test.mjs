// test/audit-fixes.test.mjs — 架构审计回归：统一契约 / 原子写 / 错误码透传 / 旧 marker 兼容
//
// 覆盖审计修复（每条均曾真实失败）：
//   1. normalizeRpc：exitCode 只由 code 推导（ERR_ASSEMBLY_* → exit 3，不再一律 1）
//   2. core/hotpack.parseHotpack：保留 shared 的 CLI 域错误码（不再吞 code）
//   3. core/ai-session.saveSession：统一 shared writeFileAtomic（无 .tmp 残留、往返一致）
//   4. core/status.statusSync：旧单 # marker 正确识别为 activePatchOk=true
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { normalizeRpc } from '../lib/gateway.js'
import { parseHotpack } from '../lib/core/hotpack.js'
import { saveSession, loadSession, sessionsDir } from '../lib/core/ai-session.js'
import { statusSync } from '../lib/core/status.js'
import { applyIsolatedEnv, isolatedDsh } from './helpers.mjs'

let restoreEnv = null
let iso = null

beforeEach(() => {
  iso = isolatedDsh()
  restoreEnv = applyIsolatedEnv(iso.dshHome)
})
afterEach(() => { if (restoreEnv) restoreEnv(); if (iso) iso.cleanup() })

describe('normalizeRpc：exitCode 只由 code 推导（审计修复）', () => {
  it('ERR_ASSEMBLY_FIELD → exit 3（此前被压成 1）', () => {
    const r = normalizeRpc({ ok: false, code: 'ERR_ASSEMBLY_FIELD', message: '字段非法' })
    expect(r.code).toBe('ERR_ASSEMBLY_FIELD')
    expect(r.exitCode).toBe(3)
  })
  it('无 code 时回退 RPC_ERROR_CODE + exit 1', () => {
    const r = normalizeRpc({ ok: false, error: 'x' })
    expect(r.exitCode).toBe(1)
  })
})

describe('core/hotpack.parseHotpack：保留 shared 错误码（审计修复）', () => {
  it('非法 JSON → code=ERR_ASSEMBLY_INVALID_JSON', () => {
    const r = parseHotpack('{ not json')
    expect(r.ok).toBe(false)
    expect(r.code).toBe('ERR_ASSEMBLY_INVALID_JSON')
  })
  it('非对象输入 → code=ERR_ASSEMBLY_FIELD', () => {
    const r = parseHotpack(null)
    expect(r.ok).toBe(false)
    expect(r.code).toBe('ERR_ASSEMBLY_FIELD')
  })
})

describe('core/ai-session.saveSession：统一原子写（审计修复）', () => {
  it('保存→读取往返一致，且无 .tmp 残留', () => {
    const ok = saveSession({ id: 's1', persona: 'maid', messages: [{ role: 'user', content: 'hi' }], pack: null, turn: 1 })
    expect(ok).toBe(true)
    const loaded = loadSession('s1')
    expect(loaded.id).toBe('s1')
    expect(loaded.messages).toEqual([{ role: 'user', content: 'hi' }])
    expect(loaded.turn).toBe(1)
    // 无 .tmp 残留（此前 writeFileSync(tmp) + rmSync(file) + writeFileSync(file) 留下死代码路径）
    const files = readdirSync(sessionsDir())
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false)
    expect(files).toContain('s1.json')
  })

  it('覆盖写入：旧内容被替换，仍无残留', () => {
    saveSession({ id: 's2', messages: [{ role: 'user', content: 'v1' }], turn: 1 })
    saveSession({ id: 's2', messages: [{ role: 'user', content: 'v2' }], turn: 2 })
    const loaded = loadSession('s2')
    expect(loaded.messages[0].content).toBe('v2')
    expect(loaded.turn).toBe(2)
    expect(readdirSync(sessionsDir()).some((f) => f.endsWith('.tmp'))).toBe(false)
  })
})

describe('core/status.statusSync：旧单 # marker 兼容（审计修复）', () => {
  function seedActivePackWithPatch(patchText) {
    const hub = join(iso.dshHome, 'hotplug-hub')
    mkdirSync(join(hub, 'packs', 'pack.test'), { recursive: true })
    writeFileSync(join(hub, 'state.json'), JSON.stringify({ version: 1, activePack: 'pack.test', history: [] }))
    writeFileSync(join(hub, 'packs', 'pack.test', 'hotpack.json'), JSON.stringify({
      hotpack: '1.0', id: 'pack.test', name: 'Test', version: '1.0.0', description: '', tags: [],
      plugins: [{ id: 'a', name: 'pkg-a', source: { type: 'npm' }, version: '1.0.0', config: {} }],
    }))
    writeFileSync(join(iso.profile, 'cordis.patch.yml'), patchText)
  }

  it('旧单 # marker 仍识别为 activePatchOk=true（此前误报 false）', () => {
    seedActivePackWithPatch('# hotplug:pack.test\n- insert:\n    - id: hp-x\n      name: \'x\'\n      config: {}\n')
    const status = statusSync()
    expect(status.activePack).toBe('pack.test')
    expect(status.activePatchOk).toBe(true)
  })

  it('契约 ## marker 仍为 true', () => {
    seedActivePackWithPatch('## hotplug:pack.test\n- insert:\n    - id: hp-x\n      name: \'x\'\n      config: {}\n')
    expect(statusSync().activePatchOk).toBe(true)
  })

  it('patch 缺失 marker 时为 false', () => {
    seedActivePackWithPatch('## desktop:other\n- insert: []\n')
    expect(statusSync().activePatchOk).toBe(false)
  })
})
