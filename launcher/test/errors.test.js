'use strict';
// test/errors.test.js — 错误码→退出码契约全表（QA Bug #1 回归）
const { ERROR_CODES, EXIT_CODE_BY_PREFIX, exitCodeForCode, makeError } = require('../contracts/errors');

describe('contracts/errors 错误码→退出码契约（QA Bug #1 回归 + M-36/37）', () => {
  it('34 个错误码唯一且全部有前缀映射（32 基线 + M-36 ERR_ARG_BAD_STATE + ERR_AI_SESSION_WRITE→RPC 域兜底 1）', () => {
    const codes = Object.values(ERROR_CODES);
    expect(codes.length).toBe(34);
    expect(new Set(codes).size).toBe(34); // 无重复
    for (const code of codes) {
      const prefix = Object.keys(EXIT_CODE_BY_PREFIX).find((p) => code.startsWith(p));
      expect(prefix, `code=${code} 无匹配前缀`).toBeTruthy();
      expect(exitCodeForCode(code), `code=${code}`).toBe(EXIT_CODE_BY_PREFIX[prefix]);
    }
  });

  it('M-36：ERR_ARG_BAD_STATE 属参数域（exit=2）', () => {
    expect(ERROR_CODES.ERR_ARG_BAD_STATE).toBe('ERR_ARG_BAD_STATE');
    expect(exitCodeForCode('ERR_ARG_BAD_STATE')).toBe(2);
  });

  it('各域退出码分布正确（2=参数 3=装配 4=冲突 5=YAML 6=安装 7=harness 8=启动 9=自愈 10=锁 11=日志 12=环境）', () => {
    const expectations = [
      ['ERR_ARG_INVALID_ID', 2],
      ['ERR_ASSEMBLY_NOT_FOUND', 3],
      ['ERR_CONFLICT_BLOCKED', 4],
      ['ERR_YAML_PARSE', 5],
      ['ERR_INSTALL_FAILED', 6],
      ['ERR_HARNESS_NOT_FOUND', 7],
      ['ERR_LAUNCH_EXIT', 8],
      ['ERR_HEAL_BUDGET', 9],
      ['ERR_LOCK_ACQUIRE', 10],
      ['ERR_LOG_WRITE', 11],
      ['ERR_ENV_UNSUPPORTED', 12]
    ];
    for (const [code, exit] of expectations) {
      expect(exitCodeForCode(code), code).toBe(exit);
    }
  });

  it('makeError 的 extra.exitCode 不覆盖契约退出码（P1 修复核心）', () => {
    const err = makeError('ERR_LAUNCH_EXIT', '子进程退出码 1', { childExitCode: 1, exitCode: 1 });
    expect(err.code).toBe('ERR_LAUNCH_EXIT');
    expect(err.exitCode).toBe(8); // 契约退出码，绝不被子进程真实退出码覆盖
    expect(err.childExitCode).toBe(1); // 子进程真实退出码保留在独立字段
  });

  it('exitCodeForCode 对未知 code 返回 1', () => {
    expect(exitCodeForCode('UNKNOWN')).toBe(1);
    expect(exitCodeForCode(null)).toBe(1);
    expect(exitCodeForCode(undefined)).toBe(1);
  });
});
