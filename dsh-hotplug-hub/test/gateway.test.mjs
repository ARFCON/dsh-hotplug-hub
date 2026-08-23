// test/gateway.test.mjs — RPC 归一化（R-v5-10）+ runCli env 净化（H-6/R-v5-9）
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { writeFileSync, mkdirSync } from 'node:fs'
import { normalizeRpc, RPC_ERROR_CODE } from '../lib/gateway.js'
import { runCli } from '../lib/core/run-cli.js'
import { applyIsolatedEnv, isolatedDsh } from './helpers.mjs'

let restoreEnv = null
let iso = null

beforeEach(() => {
  iso = isolatedDsh()
  restoreEnv = applyIsolatedEnv(iso.dshHome)
})
afterEach(() => { if (restoreEnv) restoreEnv(); if (iso) iso.cleanup() })

describe('normalizeRpc（R-v5-10）', () => {
  it('成功结果统一补 code:"OK"/exitCode:0（审计修复：RPC 信封统一）', () => {
    const r = normalizeRpc({ ok: true, data: 1 })
    expect(r.code).toBe('OK')
    expect(r.exitCode).toBe(0)
    expect(r.data).toBe(1)
    // 已带 code/exitCode 的成功结果保留原值
    expect(normalizeRpc({ ok: true, code: 'OK', data: 2, exitCode: 0 }).code).toBe('OK')
  })

  it('失败统一 {ok, code, message, exitCode}；error 兼容保留', () => {
    const r = normalizeRpc({ ok: false, error: '出错了' })
    expect(r.code).toBe(RPC_ERROR_CODE)
    expect(r.message).toBe('出错了')
    expect(r.exitCode).toBe(1)
    expect(r.error).toBe('出错了')
  })

  it('已有 code/message/exitCode 保留', () => {
    const r = normalizeRpc({ ok: false, code: 'ERR_X', message: 'm', exitCode: 7, steps: [] })
    expect(r.code).toBe('ERR_X')
    expect(r.message).toBe('m')
    expect(r.exitCode).toBe(7)
    expect(r.steps).toEqual([])
  })

  it('message 优先于 error', () => {
    const r = normalizeRpc({ ok: false, message: '新', error: '旧' })
    expect(r.message).toBe('新')
  })
})

describe('runCli（H-6 / R-v5-9）', () => {
  it('数组直连 + shell:false：注入向量作为参数传递而不被解释', async () => {
    // 用 node 自身作为"命令"：输出 args 的 JSON，验证 & 等字符原样到达
    const r = await runCli(process.execPath, ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', 'a&b;rm'], 5000, { cwd: iso.profile })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('a&b;rm')
  })

  it('env 净化：NODE_OPTIONS / NODE_TLS_REJECT_UNAUTHORIZED 等不进入子进程', async () => {
    process.env.NODE_OPTIONS = '--require=/evil.cjs'
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
    process.env.NODE_EXTRA_CA_CERTS = '/evil.pem'
    process.env.SSL_CERT_FILE = '/evil.pem'
    const r = await runCli(process.execPath, ['-e', 'console.log(JSON.stringify({o:process.env.NODE_OPTIONS,t:process.env.NODE_TLS_REJECT_UNAUTHORIZED,c:process.env.NODE_EXTRA_CA_CERTS,s:process.env.SSL_CERT_FILE}))'], 5000, { cwd: iso.profile })
    expect(r.code).toBe(0)
    const seen = JSON.parse(r.stdout)
    expect(seen.o).toBeUndefined()
    expect(seen.t).toBeUndefined()
    expect(seen.c).toBeUndefined()
    expect(seen.s).toBeUndefined()
  })

  it('命令不存在 → 返回失败结果，不抛异常', async () => {
    const r = await runCli('definitely-not-a-command-xyz', [], 2000, { cwd: iso.profile })
    // 失败形态因平台而异：POSIX 直连 spawn → error 事件（code null / signal 'error'）；
    // Windows 经 cmd.exe /c 包装 → cmd 退出码 1。核心不变量：不抛异常 + 非成功码。
    expect(r.code).not.toBe(0)
    expect(typeof r.stdout).toBe('string')
    expect(typeof r.stderr).toBe('string')
  })
})
