'use strict';
// test/qa3-cli-contract.test.js — CLI 契约（QA3 第 2 层主题 12）
// 8 命令参数矩阵 / CommandResult schema / 位置无关选项。
const os = require('os');
const { parseArgs } = require('../cli/parser');
const { formatResult, exitCodeForResult } = require('../cli/format');
const { COMMANDS } = require('../app/commands');

function isCommandResult(x) {
  return x && typeof x === 'object' &&
    typeof x.ok === 'boolean' &&
    typeof x.code === 'string' &&
    typeof x.message === 'string' &&
    ('data' in x) &&
    typeof x.exitCode === 'number';
}

describe('QA3 CLI 契约（审计 N15/N27/N40 强化）', () => {
  it('8 命令全部可解析', () => {
    for (const cmd of COMMANDS) {
      const r = parseArgs([cmd, 'some-id']);
      expect(r.ok).toBe(true);
      expect(r.command).toBe(cmd);
      expect(r.id).toBe('some-id');
    }
  });

  it('缺参：无命令 → command=null；有命令无 id → id=null', () => {
    expect(parseArgs([]).command).toBeNull();
    expect(parseArgs(['assemble']).id).toBeNull();
  });

  it('多余位置参数：第 3 个被忽略（记录行为）', () => {
    const r = parseArgs(['assemble', 'id', 'extra1', 'extra2']);
    expect(r.ok).toBe(true);
    expect(r.command).toBe('assemble');
    expect(r.id).toBe('id');
  });

  it('未知命令 → dispatch 层返回 ERR_ARG_UNKNOWN_COMMAND（exit=2）', () => {
    const r = parseArgs(['frobnicate', 'id']);
    expect(r.ok).toBe(true);
    expect(r.command).toBe('frobnicate');
    // dispatch 在 commands.js 校验
    const { dispatch } = require('../app/commands');
    return dispatch(null, r).then((res) => {
      expect(res.ok).toBe(false);
      expect(res.code).toBe('ERR_ARG_UNKNOWN_COMMAND');
      expect(res.exitCode).toBe(2);
    });
  });

  it('非法 id：normalizeAndAssert 在 pipeline 层拒绝 → exit=2（穿越向量 CLI 级）', async () => {
    const { dispatch } = require('../app/commands');
    const cases = ['../x', '..\\x', 'a/../../../x', 'C:\\Windows', 'CON', '...', 'abc '];
    for (const id of cases) {
      const parsed = parseArgs(['status', id]);
      const core = require('../app/create-core').createCore({ baseDir: __dirname + '/..', home: os.tmpdir() });
      const res = await dispatch(core, parsed);
      expect(res.ok, `应拒绝 id=${JSON.stringify(id)}`).toBe(false);
      expect(res.exitCode, `id=${JSON.stringify(id)}`).toBe(2);
    }
  });

  it('--json 位置无关：命令前 / 命令后 / id 后均解析为 json=true', () => {
    expect(parseArgs(['--json', 'status', 'id']).options.json).toBe(true);
    expect(parseArgs(['status', '--json', 'id']).options.json).toBe(true);
    expect(parseArgs(['status', 'id', '--json']).options.json).toBe(true);
  });

  it('--yes 位置无关（N15 实证）', () => {
    expect(parseArgs(['heal', '--yes', 'id']).options.yes).toBe(true);
    expect(parseArgs(['heal', 'id', '--yes']).options.yes).toBe(true);
    expect(parseArgs(['--yes', 'heal', 'id']).options.yes).toBe(true);
    expect(parseArgs(['heal', 'id']).options.yes).toBe(false);
  });

  it('--wait 位置无关', () => {
    expect(parseArgs(['launch', '--wait', 'id']).options.wait).toBe(true);
    expect(parseArgs(['launch', 'id', '--wait']).options.wait).toBe(true);
    expect(parseArgs(['launch', 'id']).options.wait).toBe(false);
    expect(parseArgs(['launch', '--no-wait', 'id']).options.wait).toBe(false);
  });

  it('--tail N：合法 / 非法 / 缺失值处理', () => {
    expect(parseArgs(['logs', 'id', '--tail', '10']).options.tail).toBe(10);
    expect(parseArgs(['logs', 'id', '--tail=20']).options.tail).toBe(20);
    expect(parseArgs(['logs', 'id']).options.tail).toBe(50); // 默认
    expect(parseArgs(['logs', 'id', '--tail', 'abc']).options.tail).toBe(50); // NaN → 默认
    expect(parseArgs(['logs', 'id', '--tail', '-5']).options.tail).toBe(50); // 负值 → 默认
    // P3 修复：--tail 0 合法（表示全部），不再回落 50
    expect(parseArgs(['logs', 'id', '--tail', '0']).options.tail).toBe(0);
  });

  it('--timeout 非法值显式报错（M-27：不再静默回退默认）；合法值透传；0 合法', () => {
    // NaN（非数字）/ 负值 → ERR_ARG_BAD_OPTION（exit=2）
    for (const bad of ['abc', '-1']) {
      const r = parseArgs(['launch', 'id', '--timeout', bad]);
      expect(r.ok, `--timeout ${bad}`).toBe(false);
      expect(r.error.code).toBe('ERR_ARG_BAD_OPTION');
      expect(r.error.exitCode).toBe(2);
    }
    expect(parseArgs(['launch', 'id', '--timeout', '500']).options.timeoutMs).toBe(500);
    expect(parseArgs(['launch', 'id', '--timeout=700']).options.timeoutMs).toBe(700);
    // M-27：0 为合法显式值（立即超时语义），原样透传
    expect(parseArgs(['launch', 'id', '--timeout', '0']).options.timeoutMs).toBe(0);
    // 缺省 null（默认超时由 launch 层决定）
    expect(parseArgs(['launch', 'id']).options.timeoutMs).toBeNull();
  });

  it('未知选项 → ERR_ARG_BAD_OPTION（exit=2）', () => {
    const r = parseArgs(['status', 'id', '--frob']);
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_ARG_BAD_OPTION');
    expect(r.error.exitCode).toBe(2);
  });

  it('--tail 缺值/后接选项 → ERR_ARG_BAD_OPTION（exit=2）', () => {
    const r = parseArgs(['logs', 'id', '--tail']);
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_ARG_BAD_OPTION');
    expect(r.error.exitCode).toBe(2);
    const r2 = parseArgs(['logs', 'id', '--tail', '--json']);
    expect(r2.ok).toBe(false);
    expect(r2.error.code).toBe('ERR_ARG_BAD_OPTION');
    // 错误返回携带已累积 options：--json 已在错误 token 前出现时透传（C1 契约）
    const r3 = parseArgs(['--json', 'logs', 'id', '--tail']);
    expect(r3.ok).toBe(false);
    expect(r3.options).toBeDefined();
    expect(r3.options.json).toBe(true);
  });

  it('解析失败仍携带已累积 options（C1：--json 先于错误 token 时失败结果走 stdout JSON）', () => {
    const r = parseArgs(['--json', 'status', '--frob']);
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_ARG_BAD_OPTION');
    expect(r.options).toBeDefined();
    expect(r.options.json).toBe(true);
    // 缺值场景同理（--json 在前，--timeout 后接选项）
    const r2 = parseArgs(['--json', 'launch', 'id', '--timeout', '--wait']);
    expect(r2.ok).toBe(false);
    expect(r2.options).toBeDefined();
    expect(r2.options.json).toBe(true);
  });

  it('CommandResult schema：formatResult --json 输出可 JSON.parse 且 5 字段齐全', () => {
    const result = { ok: true, code: 'OK', message: 'TEST OK', data: { a: 1 }, exitCode: 0 };
    const json = formatResult(result, { json: true });
    const parsed = JSON.parse(json);
    expect(isCommandResult(parsed)).toBe(true);
    expect(parsed).toEqual(result);
  });

  it('CommandResult schema：失败结果 --json 同样完整', () => {
    const result = { ok: false, code: 'ERR_HEAL_ROLLBACK', message: '无快照', data: null, exitCode: 9 };
    const parsed = JSON.parse(formatResult(result, { json: true }));
    expect(isCommandResult(parsed)).toBe(true);
    expect(parsed.exitCode).toBe(9);
  });

  it('exitCodeForResult：ok→0、exitCode 优先、否则按 code 推导', () => {
    expect(exitCodeForResult({ ok: true, code: 'OK', exitCode: 0 })).toBe(0);
    expect(exitCodeForResult({ ok: false, code: 'ERR_ARG_INVALID_ID', exitCode: 2 })).toBe(2);
    expect(exitCodeForResult({ ok: false, code: 'ERR_LAUNCH_EXIT' })).toBe(8);
    expect(exitCodeForResult(null)).toBe(1);
  });

  it('人类模式输出状态行徽标（ASSEMBLE OK / LAUNCH FAIL）', () => {
    expect(formatResult({ ok: true, message: '组装完成', data: null, exitCode: 0 }, { command: 'assemble' })).toContain('ASSEMBLE OK');
    expect(formatResult({ ok: false, message: 'spawn 失败', data: null, exitCode: 8 }, { command: 'launch' })).toContain('LAUNCH FAIL');
  });
});
