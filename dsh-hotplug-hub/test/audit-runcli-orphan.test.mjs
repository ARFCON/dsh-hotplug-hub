// test/audit-runcli-orphan.test.mjs — 审计发现：runCli 超时只 child.kill('SIGKILL') 杀直接子进程。
// Windows 下 `cmd.exe /c pnpm ...` 的直接子进程是 cmd.exe，其派生的 pnpm/node 孙进程不会被连带
// 杀掉 → 超时后形成孤儿进程（进程隔离缺陷）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { runCli } from '../lib/core/run-cli.js'
import { applyIsolatedEnv, isolatedDsh } from './helpers.mjs'

let restoreEnv = null
let iso = null

beforeEach(() => {
  iso = isolatedDsh()
  restoreEnv = applyIsolatedEnv(iso.dshHome)
})
afterEach(() => { if (restoreEnv) restoreEnv(); if (iso) iso.cleanup() })

/** 轮询等待文件出现。 */
async function waitFor(file, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(file)) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return existsSync(file)
}

describe.skipIf(process.platform !== 'win32')('runCli 超时孤儿进程（BUG 复现）', () => {
  it('超时 kill cmd.exe 后，其派生的孙进程（node marker）成为孤儿', { timeout: 20000 }, async () => {
    const pidFile = join(iso.dshHome, 'orphan.pid')
    const markerJs = join(iso.dshHome, 'marker.js')
    // 孙进程：先写 pid，再长睡 10s（确保超时 kill 时它仍在运行）
    writeFileSync(markerJs, [
      'const fs = require("fs");',
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      'const deadline = Date.now() + 10000;',
      'while (Date.now() < deadline) {',
      '  const sab = new SharedArrayBuffer(4); const a = new Int32Array(sab);',
      '  Atomics.wait(a, 0, 0, 100);',
      '}',
    ].join('\n'))
    // pnpm.cmd：同步调用 node marker.js（node 为孙进程）
    writeFileSync(join(iso.dshHome, 'pnpm.cmd'), `@echo off\r\n"${process.execPath}" "${markerJs}"\r\n`)

    const rPromise = runCli('pnpm', [], 1000) // 超时 1000ms
    // 等孙进程已启动（pid 文件出现）
    const started = await waitFor(pidFile)
    expect(started).toBe(true)
    const pid = Number(readFileSync(pidFile, 'utf8'))

    // 等 runCli 结算：close 事件 = 子进程退出且 stdio 管道关闭（孙进程继承管道句柄，
    // 管道关闭意味着整棵进程树已死）——这是「进程树已清理」的可靠信号
    const r = await rPromise
    expect(r.timedOut).toBe(true) // 超时路径显式标记（修复：不再误报 code:1）

    let alive = true
    try { process.kill(pid, 0) } catch { alive = false }

    // BUG 复现：超时后孙进程应已随整棵进程树被清理，不得成为孤儿
    expect(alive).toBe(false)

    // 兜底清理（理论上不应到达）
    if (alive) { try { process.kill(pid, 'SIGKILL') } catch {} }
  })
})
