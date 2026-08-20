'use strict';
// cli/parser.js — 参数解析（--yes/--wait/--json 位置无关）
//
// 审计修复：N15（`heal --yes <id>` 把 --yes 误当 id）—
// 选项可从任意位置提取，位置参数只取命令与 id。
const { makeError } = require('../contracts/errors');

const COMMANDS = ['assemble', 'check', 'install', 'launch', 'heal', 'status', 'rollback', 'logs'];

/**
 * 解析命令行参数。
 * @param {Array<string>} argv process.argv.slice(2)
 * @returns {{ok: boolean, command?: string|null, id?: string|null, options?: object, error?: Error}}
 */
function parseArgs(argv) {
  const options = {
    yes: false,
    json: false,
    wait: false,
    timeoutMs: null,
    tail: 50
  };
  const positional = [];
  const tokens = Array.isArray(argv) ? argv.slice() : [];

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t === '--yes' || t === '-y') {
      options.yes = true;
    } else if (t === '--help' || t === '-h') {
      // P3：--help 输出用法（exit 0），不再被当作未知选项
      return { ok: true, help: true, command: null, id: null, options };
    } else if (t === '--json') {
      options.json = true;
    } else if (t === '--wait') {
      options.wait = true;
    } else if (t === '--no-wait') {
      options.wait = false;
    } else if (t === '--timeout') {
      // C1 修复：缺值或下一个 token 是选项（如 --timeout --json）→ ERR_ARG_BAD_OPTION，
      // 不得静默吞掉后续选项；仅"值本身非法数字"才回退默认。
      // 注：仅当下一 token 以 '--' 开头才判为"选项被吞"（'-1' 这类负数值仍按值处理）。
      const val = tokens[i + 1];
      if (val === undefined || (typeof val === 'string' && val.startsWith('--'))) {
        return { ok: false, error: makeError('ERR_ARG_BAD_OPTION', `--timeout 缺少数值参数（后接 ${val === undefined ? '行尾' : JSON.stringify(val)}）`) };
      }
      options.timeoutMs = Number(val);
      i += 1;
    } else if (t.startsWith('--timeout=')) {
      options.timeoutMs = Number(t.slice('--timeout='.length));
    } else if (t === '--tail') {
      const val = tokens[i + 1];
      if (val === undefined || (typeof val === 'string' && val.startsWith('--'))) {
        return { ok: false, error: makeError('ERR_ARG_BAD_OPTION', `--tail 缺少数值参数（后接 ${val === undefined ? '行尾' : JSON.stringify(val)}）`) };
      }
      options.tail = Number(val);
      i += 1;
    } else if (t.startsWith('--tail=')) {
      options.tail = Number(t.slice('--tail='.length));
    } else if (t.startsWith('-') && t !== '-') {
      const err = makeError('ERR_ARG_BAD_OPTION', `未知选项：${t}`);
      return { ok: false, error: err };
    } else {
      positional.push(t);
    }
  }

  if (Number.isNaN(options.timeoutMs) || options.timeoutMs <= 0) options.timeoutMs = null;
  // P3：--tail 0 合法（表示全部），仅 NaN/负值回退默认 50
  if (Number.isNaN(options.tail) || options.tail < 0) options.tail = 50;

  return {
    ok: true,
    command: positional[0] || null,
    id: positional[1] || null,
    options
  };
}

module.exports = { parseArgs, COMMANDS };
