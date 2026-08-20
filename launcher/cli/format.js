'use strict';
// cli/format.js — 人类 + JSON 双模式输出
//
// 文本风格：状态行 = 大写动词徽标（ASSEMBLE OK / CHECK OK / ...）；
// 失败信息走 message；JSON 模式输出完整 CommandResult。
const { exitCodeForCode } = require('../contracts/errors');

const BADGE_BY_COMMAND = {
  assemble: 'ASSEMBLE',
  check: 'CHECK',
  install: 'INSTALL',
  launch: 'LAUNCH',
  heal: 'HEAL',
  status: 'STATUS',
  rollback: 'ROLLBACK',
  logs: 'LOGS'
};

function badgeFor(command, ok) {
  const base = BADGE_BY_COMMAND[command] || 'CMD';
  return ok ? `${base} OK` : `${base} FAIL`;
}

function formatScalar(value, indent) {
  const pad = ' '.repeat(indent);
  if (value === null || value === undefined) return `${pad}(null)`;
  if (typeof value === 'object') return formatData(value, indent);
  return `${pad}${String(value)}`;
}

function formatData(data, indent = 2) {
  if (data === null || data === undefined) return '';
  if (Array.isArray(data)) {
    if (data.length === 0) return `${' '.repeat(indent)}[]`;
    return data.map((x) => formatScalar(x, indent)).join('\n');
  }
  if (typeof data === 'object') {
    const pad = ' '.repeat(indent);
    return Object.entries(data)
      .map(([k, v]) => {
        if (typeof v === 'object' && v !== null) {
          return `${pad}${k}:` + (Array.isArray(v) && v.length === 0 ? ' []' : '\n' + formatScalar(v, indent + 2));
        }
        return `${pad}${k}: ${String(v)}`;
      })
      .join('\n');
  }
  return `${' '.repeat(indent)}${String(data)}`;
}

/**
 * 格式化 CommandResult 为文本。
 * @param {object} result CommandResult
 * @param {object} [opts]
 * @param {boolean} [opts.json] JSON 模式
 * @param {string} [opts.command] 命令名（用于徽标）
 * @returns {string}
 */
function formatResult(result, opts = {}) {
  if (opts.json) {
    return JSON.stringify(result, null, 2);
  }
  const badge = badgeFor(opts.command, result.ok);
  const lines = [`${badge} ${result.message}`];
  if (result.data) {
    const body = formatData(result.data, 2);
    if (body) lines.push(body);
  }
  return lines.join('\n');
}

/**
 * 由 CommandResult 计算进程退出码。
 * @param {object} result
 * @returns {number}
 */
function exitCodeForResult(result) {
  if (!result) return 1;
  if (result.exitCode !== undefined && result.exitCode !== null) return result.exitCode;
  if (result.ok) return 0;
  return exitCodeForCode(result.code);
}

module.exports = { formatResult, exitCodeForResult, badgeFor };
