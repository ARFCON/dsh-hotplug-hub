// test/run-cli-windows.test.mjs — runCli 对 Windows .cmd/.bat/裸命令的 cmd.exe 包装（C6 同源修复）
//
// 根因（先红后修）：npm 全局安装的 pnpm 在 Windows 上只生成 `pnpm.cmd`（非 pnpm.exe），
// 而 runCli 此前用 spawn(command, args, {shell:false}) 直连——Node ≥18.20/20.12/21.7 起
// （CVE-2024-27980 修复）对 .cmd/.bat 直接 CreateProcess 抛 EINVAL，导致：
//   - checkAsync 的 pnpm --version 永远失败 → 自检「pnpm」误报未安装；
//   - ensureNpm / unmountPack / rollbackMount 的 pnpm add/remove 全部失效。
// launcher infra/launch.js 已有 C6 结论（cmd.exe /d /c 包装）；本测试证明 hotplug runCli
// 同步对齐该结论。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runCli } from '../lib/core/run-cli.js'
import { checkAsync } from '../lib/core/status.js'
import { applyIsolatedEnv, isolatedDsh } from './helpers.mjs'

let restoreEnv = null
let iso = null

beforeEach(() => {
  iso = isolatedDsh()
  restoreEnv = applyIsolatedEnv(iso.dshHome)
})
afterEach(() => { if (restoreEnv) restoreEnv(); if (iso) iso.cleanup() })

/** 在隔离 PATH 放置真实 pnpm.cmd（echo 版本），模拟 npm install -g pnpm 的标准产物形态。 */
function writePnpmCmd(version = '7.7.7') {
  writeFileSync(join(iso.dshHome, 'pnpm.cmd'), `@echo off\r\necho ${version}\r\n`)
}

describe.skipIf(process.platform !== 'win32')('runCli Windows .cmd 包装（C6 回归）', () => {
  it('裸命令 pnpm（实为 pnpm.cmd）经 cmd.exe /d /c 包装可成功执行', async () => {
    writePnpmCmd()
    const r = await runCli('pnpm', ['--version'], 5000)
    expect(r.code).toBe(0)
    expect(r.signal).toBeNull()
    expect((r.stdout || '').trim()).toBe('7.7.7')
  })

  it('checkAsync 在 pnpm 以 .cmd 形态安装时仍能探测到版本（自检不误报缺失）', async () => {
    writePnpmCmd()
    const r = await checkAsync()
    expect(r.pnpmVersion).toBe('7.7.7')
  })

  it('.exe 形态（pnpm.exe）仍正常直连 spawn，不因包装逻辑失效', async () => {
    // pnpm.exe = node.exe 副本：`node --version` 输出 node 版本（v 前缀），验证直连路径
    const { copyFileSync } = await import('node:fs')
    copyFileSync(process.execPath, join(iso.dshHome, 'pnpm.exe'))
    const r = await runCli('pnpm', ['--version'], 5000)
    expect(r.code).toBe(0)
    expect((r.stdout || '').trim()).toMatch(/^v\d+\.\d+\.\d+/)
  })
})
