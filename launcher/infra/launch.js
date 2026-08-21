'use strict';
// infra/launch.js — spawn 双形态 + 退出码 + 超时 + unref
//
// 审计修复：
//   - N：spawn 双形态统一 —— ENOENT 走异步 error 事件、UNKNOWN/EACCES 走同步 throw，
//     两者都映射 ERR_LAUNCH_SPAWN，绝不允许"LAUNCH OK 假成功"
//   - C/N29：detach 模式存活确认后 unref（不挂起）；--wait 等待退出码并传播
//   - L：DSH_PROFILE 与 --profile 双通道传递
const {
  LAUNCH_ALIVE_CHECK_MS,
  LAUNCH_WAIT_TIMEOUT_MS
} = require('../contracts/constants');
const { makeError } = require('../contracts/errors');
const { sanitizeChildEnv } = require('@dsh/shared-core/security/net');

// C6 修复：win32 下 spawn .cmd/.bat 直接执行抛 EINVAL（shell 脚本不可直接 CreateProcess），
// 必须经 cmd.exe /d /c 包装（手册 §3.4.6 极端情况处理；PATH 回退命中 dsh.cmd 的路径）。
// 引号规则（实测确定）：Node spawn 会把参数内嵌引号转义为 \"（cmd 不识别），因此
// 路径/参数一律不带手写引号，由 libuv 对含空格参数自动包裹；含 cmd 特殊字符
// （&|<>^%()!"）的路径/参数显式拒绝——否则 cmd 会按特殊字符解析（命令注入/引号破坏）。
// cmd 解析器用 ComSpec（Windows 恒存在的绝对路径），避免 PATH 被清空时 cmd.exe ENOENT。
// 特殊字符集见 infra/cmd-special.js（CMD_EXE_SPECIAL_RE，与契约 CMD_SPECIAL_RE 不同集）。
const { CMD_EXE_SPECIAL_RE } = require('./cmd-special');

function isCmdScript(harness) {
  return typeof harness === 'string' && /\.(cmd|bat)$/i.test(harness);
}

/**
 * 构造 cmd 包装。
 * @param {string} harness .cmd/.bat 脚本路径
 * @param {Array<string>} args 脚本参数（win32 下 stageLaunch 为空数组）
 * @param {string} cmdBin ComSpec 或 cmd.exe
 * @returns {{ok: boolean, bin?: string, args?: Array<string>, error?: Error}}
 */
function wrapCmdScript(harness, args, cmdBin) {
  if (CMD_EXE_SPECIAL_RE.test(String(harness))) {
    return { ok: false, error: makeError('ERR_LAUNCH_SPAWN', `harness 路径含 cmd 特殊字符，拒绝经 cmd 执行：${harness}`) };
  }
  for (const a of args || []) {
    if (CMD_EXE_SPECIAL_RE.test(String(a))) {
      return { ok: false, error: makeError('ERR_LAUNCH_SPAWN', `参数含 cmd 特殊字符，拒绝经 cmd 执行：${a}`) };
    }
  }
  return { ok: true, bin: cmdBin || 'cmd.exe', args: ['/d', '/c', harness, ...(args || [])] };
}

/**
 * 启动子进程。
 * @param {object} core
 * @param {object} opts
 * @param {string} opts.harness 可执行文件
 * @param {string} opts.profile cwd
 * @param {Array<string>} [opts.args] 额外参数（--profile 等）
 * @param {object} [opts.env] 附加环境变量（DSH_PROFILE 等）
 * @param {boolean} [opts.wait] true=等待退出并传播退出码；false=detach 存活确认
 * @param {number} [opts.timeoutMs] --wait 超时
 * @param {Function} [opts.onStdout] (chunk) => void
 * @param {Function} [opts.onStderr] (chunk) => void
 * @param {Function} [opts.onExit] (info) => void 子进程退出时回调（{exitCode, signal}），
 *   两种模式均会触发——供调用方在进程真正结束时冲刷解码器尾部（C6 修复：
 *   stageLaunch 借此 flush 半行/残缺多字节，run.jsonl 不再丢失尾行）
 * @returns {Promise<{ok: boolean, result?: object, error?: Error}>}
 */
async function launchProcess(core, opts) {
  const {
    harness,
    profile,
    args = [],
    env = {},
    wait = false,
    timeoutMs = LAUNCH_WAIT_TIMEOUT_MS,
    onStdout = null,
    onStderr = null,
    onExit = null
  } = opts;

  const spawnOpts = {
    cwd: profile,
    // M-2（安全审计）：harness 子进程 env 净化——TLS/CA/SSL 变量与 NODE_OPTIONS
    // 之外的注入面一律剥离；NODE_OPTIONS 保留（keepNodeOptions）：harness 已经
    // N44 校验且本就执行 profile 代码，透传无边际风险，且 QA 录制器（DoD-2
    // recorder / keepalive）依赖该注入通道（详见 shared-core security/net 说明）。
    env: { ...sanitizeChildEnv(core.config.env || process.env, { keepNodeOptions: true }), ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  };

  // C6 修复：win32 下 .cmd/.bat harness 经 cmd.exe 包装（否则 spawn EINVAL）；
  // cmd 解析器优先 ComSpec——注意不能只查 core.config.env（测试注入的 env 快照
  // 可能丢失不可枚举的 ComSpec，实测 vitest worker 中 spread 后即缺失），
  // 需回退直读 process.env.ComSpec（机器级常量）。
  let bin = harness;
  let argsList = args;
  if (core.config.platform === 'win32' && isCmdScript(harness)) {
    const comspec = (core.config.env && core.config.env.ComSpec) || process.env.ComSpec || 'cmd.exe';
    const wrapped = wrapCmdScript(harness, args, comspec);
    if (!wrapped.ok) return { ok: false, error: wrapped.error };
    bin = wrapped.bin;
    argsList = wrapped.args;
  }

  let child;
  try {
    child = core.ports.proc.spawn(bin, argsList, spawnOpts);
  } catch (e) {
    // 同步 throw 形态（UNKNOWN/EACCES/损坏 exe）
    return { ok: false, error: makeError('ERR_LAUNCH_SPAWN', `spawn 同步失败：${e.message}`, { cause: e }) };
  }

  const notifyExit = (exitCode, signal) => {
    if (onExit && typeof onExit === 'function') {
      try { onExit({ exitCode, signal }); } catch (_) { /* 回调失败不影响主流程 */ }
    }
  };

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const settle = (r) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };

    child.on('error', (err) => {
      // 异步 error 事件形态（ENOENT）
      if (timer) clearTimeout(timer); // FIX-12：error 路径清除超时 timer，避免钉住事件循环
      settle({ ok: false, error: makeError('ERR_LAUNCH_SPAWN', `spawn 失败：${err.message}`, { cause: err }) });
    });

    if (child.stdout) child.stdout.on('data', (d) => onStdout && onStdout(d));
    if (child.stderr) child.stderr.on('data', (d) => onStderr && onStderr(d));

    if (wait) {
      timer = setTimeout(() => {
        // 超时清理（手册 §3.4.6：超时 → ERR_LAUNCH_TIMEOUT + SIGTERM 清理，防孤儿进程）
        let signalSent = false;
        try {
          if (typeof child.kill === 'function') signalSent = child.kill('SIGTERM');
        } catch (_) { /* 已退出则忽略 */ }
        if (signalSent) {
          // SIGKILL 兜底：SIGTERM 未能及时终止时强制清理（unref 避免再次钉住事件循环）
          const force = setTimeout(() => {
            try { if (typeof child.kill === 'function') child.kill('SIGKILL'); } catch (_) { /* 已退出 */ }
          }, 1000);
          if (typeof force.unref === 'function') force.unref();
        }
        settle({ ok: false, error: makeError('ERR_LAUNCH_TIMEOUT', `等待退出超时（${timeoutMs}ms）`) });
      }, timeoutMs);
      child.once('exit', (exitCode, signal) => {
        clearTimeout(timer);
        notifyExit(exitCode, signal);
        if (exitCode !== 0) {
          settle({
            ok: false,
            error: makeError('ERR_LAUNCH_EXIT', `子进程退出码 ${exitCode}${signal ? '，信号 ' + signal : ''}`, { childExitCode: exitCode, signal })
          });
        } else {
          settle({ ok: true, result: { pid: child.pid, exitCode, signal, mode: 'wait' } });
        }
      });
    } else {
      // detach：存活确认窗口内未退出才 unref 返回
      let exited = false;
      child.once('exit', (exitCode, signal) => {
        exited = true;
        notifyExit(exitCode, signal);
      });
      setTimeout(() => {
        if (exited) {
          settle({ ok: false, error: makeError('ERR_LAUNCH_DETACH', '子进程在存活确认窗口内退出') });
          return;
        }
        try {
          child.unref();
        } catch (_) { /* unref 不可用可忽略 */ }
        settle({ ok: true, result: { pid: child.pid, mode: 'detach', alive: true } });
      }, LAUNCH_ALIVE_CHECK_MS);
    }
  });
}

module.exports = { launchProcess, isCmdScript, wrapCmdScript };
