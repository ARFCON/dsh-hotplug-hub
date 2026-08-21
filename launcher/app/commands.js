'use strict';
// app/commands.js — 8 命令实现（薄分发层，逻辑在 pipeline）
//
// 命令：assemble / check / install / launch / heal / status / rollback / logs
// M-28（v5 阶段 5）：返回边界经 shared schemas 校验 CommandResult。
const { runPipeline } = require('./pipeline');
const { makeError, exitCodeForCode } = require('../contracts/errors');
const { validateCommandResult } = require('../contracts/schemas');

const COMMANDS = ['assemble', 'check', 'install', 'launch', 'heal', 'status', 'rollback', 'logs'];

function usageResult() {
  return {
    ok: false,
    code: 'ERR_ARG_MISSING_ARG',
    message: [
      'DSH-Hotplug-Hub Launcher（参考实现）',
      '用法:',
      '  node index.js assemble <id>           组装 + 解析 + 冲突预检 + 生成 sandbox 产物',
      '  node index.js check <id>              只读冲突预检（零副作用）',
      '  node index.js install <id>            安装插件（dsh plugin add 通道 + 降级）',
      '  node index.js launch <id> [--wait]    同步 profile 并启动 DSH（默认 detach）',
      '  node index.js heal <id> [--yes]       自愈（默认预览；--yes 执行）',
      '  node index.js status <id>             只读状态报告',
      '  node index.js rollback <id>           回滚到最近快照',
      '  node index.js logs <id> [--tail N]    查看 run.jsonl',
      '全局选项: --json 输出 JSON；--yes/--wait/--timeout 位置无关'
    ].join('\n'),
    data: null,
    // 缺参/未知命令统一走 ERR_ARG_MISSING_ARG 契约退出码（=2），与 code 一致
    exitCode: exitCodeForCode('ERR_ARG_MISSING_ARG')
  };
}

/**
 * --help 输出（exit 0）。
 * C1 修复：ok:true + code:'OK'——此前展开 usageResult（ok:false）导致
 * --help 被路由到 stderr，且 JSON 消费方会误判为错误。
 * @returns {object} CommandResult
 */
function helpResult() {
  const u = usageResult();
  return { ...u, ok: true, code: 'OK', exitCode: 0 };
}

/**
 * 命令分发。
 * @param {object} core
 * @param {object} parsed parser 产物 { command, id, options }
 * @returns {Promise<object>} CommandResult
 */
async function dispatch(core, parsed) {
  if (!parsed.ok) {
    return {
      ok: false,
      code: parsed.error.code,
      message: parsed.error.message,
      data: null,
      exitCode: parsed.error.exitCode
    };
  }
  if (parsed.help) return helpResult();
  if (!parsed.command) return usageResult();
  if (!COMMANDS.includes(parsed.command)) {
    const err = makeError('ERR_ARG_UNKNOWN_COMMAND', `未知命令：${parsed.command}`);
    return { ok: false, code: err.code, message: err.message, data: null, exitCode: err.exitCode };
  }
  if (!parsed.id) return usageResult();

  const result = await runPipeline(core, parsed.command, {
    id: parsed.id,
    yes: Boolean(parsed.options.yes),
    wait: Boolean(parsed.options.wait),
    // M-27：0 为合法显式值（原样透传）；null 缺省
    timeoutMs: parsed.options.timeoutMs === null ? undefined : parsed.options.timeoutMs,
    tail: parsed.options.tail
  });
  // M-28：返回边界 schema 校验（契约违规显式报错，不静默透传）
  const check = validateCommandResult(result);
  if (!check.ok) {
    const err = makeError('ERR_ENV_UNSUPPORTED', `CommandResult 不符合 schema：${check.errors.join('；')}`);
    return { ok: false, code: err.code, message: err.message, data: null, exitCode: err.exitCode };
  }
  return result;
}

module.exports = { dispatch, COMMANDS, usageResult, helpResult };
