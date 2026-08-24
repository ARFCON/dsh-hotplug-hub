/**
 * lib/core/run-cli.js — 命令执行（v5 阶段 3 自 index.js 拆出）
 *
 * R-v5-9 / H-6（v5 阶段 1）：数组直连 + shell:false（曾 shell:IS_WIN 可注入 P14 实证）；
 * 子进程 env 一律净化（删 NODE_TLS_REJECT_UNAUTHORIZED/NODE_OPTIONS/NODE_EXTRA_CA_CERTS/
 * SSL_CERT_FILE/SSL_CERT_DIR——TLS 校验不可被静默关闭、Node 行为不可被注入）。
 */
import { spawn } from 'node:child_process'
import { extname, join } from 'node:path'
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

/**
 * 终止子进程整棵进程树（审计修复：进程隔离）。
 * Windows 下 `cmd.exe /c pnpm ...` 的直接子进程是 cmd.exe，其派生的 pnpm/git/node
 * 孙进程不会被 `child.kill('SIGKILL')` 连带杀掉 → 超时后成孤儿。用 taskkill /T /F
 * 杀整棵进程树；taskkill 走 SystemRoot 绝对路径（PATH 被隔离时仍可用），失败回退 kill。
 * POSIX 下保持 kill（信号直接子进程）。
 */
function killChildTree(child) {
  if (!child || typeof child.pid !== 'number') return
  if (process.platform === 'win32') {
    const taskkill = process.env.SystemRoot ? join(process.env.SystemRoot, 'System32', 'taskkill.exe') : 'taskkill'
    try {
      const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      killer.on('error', () => { try { child.kill('SIGKILL') } catch { /* 忽略 */ } })
    } catch {
      try { child.kill('SIGKILL') } catch { /* 忽略 */ }
    }
  } else {
    try { child.kill('SIGKILL') } catch { /* 忽略 */ }
  }
}

export function runCli(command, args, timeoutMs, options = {}) {
  return new Promise((resolve) => {
    let bin = command
    let argv = args
    if (isWindowsShellCommand(command)) {
      bin = process.env.ComSpec || 'cmd.exe'
      argv = ['/d', '/c', command, ...args]
    }
    // 审计修复（通道行为对齐）：输出上限可由调用方放宽（默认 OUTPUT_CAP 不变）——
    // 市场抓取的 curl 兜底需要与 fetch 分支一致的 MARKET_MAX_BODY_CHARS 上限，
    // 而此前两通道一个无上限、一个被 64KB 截断，同一 README 结果漂移。
    const outputCap = typeof options.maxOutput === 'number' && options.maxOutput > 0 ? options.maxOutput : OUTPUT_CAP
    const child = spawn(bin, argv, {
      cwd: options.cwd ?? profileDir(),
      env: sanitizeChildEnv(process.env),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    })
    let stdout = ''
    let stderr = ''
    // 审计修复（超时退出码误报）：Windows 下 taskkill /F 以 TerminateProcess(exitCode=1)
    // 实现，close 会拿到 code:1,signal:null——调用方（ensureNpm/unmountPack/checkAsync）会把
    // 「超时被杀」误读为「命令失败 exit 1」。超时路径显式标记 timedOut 并归一为 code:null。
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killChildTree(child)
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    child.stdout.on('data', (chunk) => {
      if (stdout.length < outputCap) stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < outputCap) stderr += String(chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: null, signal: 'error', stdout, stderr: `${stderr}\n${String(error.message ?? error)}` })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (timedOut) resolve({ code: null, signal: 'SIGKILL', timedOut: true, stdout, stderr })
      else resolve({ code, signal, stdout, stderr })
    })
  })
}

export function tail(text, lines = 8) {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '') return ''
  return trimmed.split('\n').slice(-lines).join('\n')
}
