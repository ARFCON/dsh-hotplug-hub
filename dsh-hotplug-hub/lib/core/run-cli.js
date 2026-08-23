/**
 * lib/core/run-cli.js — 命令执行（v5 阶段 3 自 index.js 拆出）
 *
 * R-v5-9 / H-6（v5 阶段 1）：数组直连 + shell:false（曾 shell:IS_WIN 可注入 P14 实证）；
 * 子进程 env 一律净化（删 NODE_TLS_REJECT_UNAUTHORIZED/NODE_OPTIONS/NODE_EXTRA_CA_CERTS/
 * SSL_CERT_FILE/SSL_CERT_DIR——TLS 校验不可被静默关闭、Node 行为不可被注入）。
 */
import { spawn } from 'node:child_process'
import { extname } from 'node:path'
import { sanitizeChildEnv } from '../../vendor-shared/index.mjs'
import { IS_WIN, OUTPUT_CAP, profileDir } from './paths.js'

/**
 * C6 修复（与 launcher infra/launch.js wrapCmdScript 同源）：Windows 下 `.cmd` / `.bat`
 * / 裸命令（如 `pnpm`，npm 全局安装只生成 `pnpm.cmd` 而非 `pnpm.exe`）不能被
 * CreateProcess 直接启动（Node spawn shell:false 抛 EINVAL），必须经 ComSpec
 * （cmd.exe /d /c）包装。ComSpec 用绝对路径，避免 PATH 被隔离（如测试隔离环境）
 * 时 `cmd.exe` 自身 ENOENT。
 * 注：curl.exe / tar.exe 已带 `.exe` 扩展名，不命中本分支，仍走直接 spawn。
 */
function isWindowsShellCommand(command) {
  if (!IS_WIN) return false
  const ext = extname(String(command ?? '')).toLowerCase()
  return ext === '' || ext === '.cmd' || ext === '.bat'
}

export function runCli(command, args, timeoutMs, options = {}) {
  return new Promise((resolve) => {
    let bin = command
    let argv = args
    if (isWindowsShellCommand(command)) {
      bin = process.env.ComSpec || 'cmd.exe'
      argv = ['/d', '/c', command, ...args]
    }
    const child = spawn(bin, argv, {
      cwd: options.cwd ?? profileDir(),
      env: sanitizeChildEnv(process.env),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* 有意吞掉：尽力而为的清理/读取，失败不影响主流程 */ }
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    child.stdout.on('data', (chunk) => {
      if (stdout.length < OUTPUT_CAP) stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < OUTPUT_CAP) stderr += String(chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: null, signal: 'error', stdout, stderr: `${stderr}\n${String(error.message ?? error)}` })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr })
    })
  })
}

export function tail(text, lines = 8) {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '') return ''
  return trimmed.split('\n').slice(-lines).join('\n')
}
