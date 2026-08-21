#!/usr/bin/env node
'use strict';
// index.js — CLI 入口接线（只做解析 → 分发 → 格式化 → 退出码）
const path = require('path');
const { parseArgs } = require('./cli/parser');
const { formatResult, exitCodeForResult } = require('./cli/format');
const { createCore } = require('./app/create-core');
const { dispatch } = require('./app/commands');
const { isDshError, makeError } = require('./contracts/errors');

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    const result = {
      ok: false,
      code: parsed.error.code,
      message: parsed.error.message,
      data: null,
      exitCode: parsed.error.exitCode
    };
    // C1 修复：--json 模式失败结果也走 stdout（机器可读契约），文本模式走 stderr
    writeResult(result, parsed.options);
    setExit(result.exitCode);
    return;
  }

  // 根目录解析（上游适配）：
  //   - DSH_HOTPLUG_ROOT 显式指定（CI/QA 脚本隔离用，H-1：整个根域落其下）；
  //   - 缺省 = launcher 模块的上一级目录：仓库内为仓库根（与旧版 launcher 的
  //     assembly/sandbox 布局一致），独立部署时即模块所在目录（自包含）。
  const baseDir = process.env.DSH_HOTPLUG_ROOT
    ? path.resolve(process.env.DSH_HOTPLUG_ROOT)
    : path.resolve(__dirname, '..');
  const core = createCore({ baseDir });
  // FIX-12：SIGINT/SIGTERM 优雅退出——释放活动锁（若有），输出友好提示
  // C1 修复：信号路径用 fs.writeSync 同步写（此时可能处于锁等待的阻塞轮询中，
  // 事件循环不可用，process.stderr.write 可能不落盘）。
  // M-30 修复（v5 阶段 2）：信号处理器随 main 结束注销（CLI 单次执行；避免
  // 模块化导入测试时处理器泄漏）。
  const onSignal = (code) => {
    try {
      if (core._activeLock) {
        core.infra.lock.releaseLock(core.ports.fs, core._activeLock.lockPath, {
          owner: core._activeLock.owner,
          pid: process.pid,
          fd: core._activeLock.fd
        });
      }
    } catch (_) { /* 释放失败不影响退出 */ }
    try {
      require('fs').writeSync(2, `\n收到中断信号，退出（exit ${code}）\n`);
    } catch (_) { /* 忽略 */ }
    process.exit(code);
  };
  const sigint = () => onSignal(130);
  const sigterm = () => onSignal(143);
  process.on('SIGINT', sigint);
  process.on('SIGTERM', sigterm);
  try {
    const result = await dispatch(core, parsed);
    writeResult(result, { json: parsed.options.json, command: parsed.command });
    setExit(exitCodeForResult(result));
  } finally {
    process.removeListener('SIGINT', sigint);
    process.removeListener('SIGTERM', sigterm);
  }
}

/**
 * 输出结果：--json 模式一律 stdout（jq/CI 消费）；文本模式成功走 stdout、失败走 stderr。
 * C1 修复：不使用 process.exit() 立即终止（管道下 stdout 异步缓冲可能被截断），
 * 改为设置 process.exitCode 后自然退出，让事件循环排空输出。
 */
function writeResult(result, opts) {
  const out = formatResult(result, opts) + '\n';
  if (opts && opts.json) {
    process.stdout.write(out);
  } else if (result.ok) {
    process.stdout.write(out);
  } else {
    process.stderr.write(out);
  }
}

function setExit(code) {
  process.exitCode = code;
}

// M-30：仅直接执行（node index.js）时运行；模块化导入导出 main 供测试。
// M-29 修复（v5 阶段 2）：裸错误（非 ERR_ 码）归一化为 ERR_ENV_UNSUPPORTED
// 结构化结果（exit 12），不再以无码 FATAL + exit 1 退出。
if (require.main === module) {
  main().catch((err) => {
    if (isDshError(err)) {
      writeResult({ ok: false, code: err.code, message: err.message, data: null, exitCode: err.exitCode }, { json: false });
      setExit(err.exitCode);
      return;
    }
    const wrapped = makeError('ERR_ENV_UNSUPPORTED', `内部错误：${err && err.message ? err.message : String(err)}`, { cause: err });
    writeResult({ ok: false, code: wrapped.code, message: wrapped.message, data: null, exitCode: wrapped.exitCode }, { json: false });
    setExit(wrapped.exitCode);
  });
}

module.exports = { main, writeResult, setExit };
