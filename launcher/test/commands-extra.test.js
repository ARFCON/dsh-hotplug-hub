'use strict';
// test/commands-extra.test.js — app/commands.js dispatch 边界（M-28）
// 覆盖：解析失败对象直入 dispatch（54-61，错误对象 → 结构化 CommandResult）。
//
// 注：M-28 的 schema 违规分支（81-83）无法经模块替换触达——vitest 对 CJS
// require() 不做拦截（与 #6168 同根因：istanbul 覆盖率 0% 的原因），vi.mock/
// vi.doMock 均不生效；而真实 pipeline 的全部阶段结果都经 okResult/errResult
// 构造（必然合规），该分支是纯防御代码。校验器本身由 shared-core schemas 测试
// 与 qa3-cli-contract 的 formatResult 用例覆盖。
const { makeError } = require('../contracts/errors');

describe('app/commands.js dispatch 边界（M-28）', () => {
  it('解析失败对象 → 结构化 CommandResult（code/message/exitCode 透传）', async () => {
    const { dispatch } = require('../app/commands');
    const err = makeError('ERR_ARG_BAD_OPTION', '未知选项：--x');
    const r = await dispatch({}, { ok: false, error: err });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ERR_ARG_BAD_OPTION');
    expect(r.message).toBe('未知选项：--x');
    expect(r.data).toBeNull();
    expect(r.exitCode).toBe(2);
  });

  it('缺命令 → usage（ERR_ARG_MISSING_ARG，exit 2）', async () => {
    const { dispatch } = require('../app/commands');
    const r = await dispatch({}, { ok: true, command: null, id: null, options: {} });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ERR_ARG_MISSING_ARG');
    expect(r.message).toContain('用法');
  });

  it('未知命令 → ERR_ARG_UNKNOWN_COMMAND（exit 2）', async () => {
    const { dispatch } = require('../app/commands');
    const r = await dispatch({}, { ok: true, command: 'frobnicate', id: 'x', options: {} });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ERR_ARG_UNKNOWN_COMMAND');
    expect(r.exitCode).toBe(2);
  });

  it('--help → 成功结果（ok:true，exit 0，C1：帮助不再走 stderr）', async () => {
    const { dispatch } = require('../app/commands');
    const r = await dispatch({}, { ok: true, help: true, command: null, id: null, options: {} });
    expect(r.ok).toBe(true);
    expect(r.code).toBe('OK');
    expect(r.exitCode).toBe(0);
    expect(r.message).toContain('用法');
  });
});
