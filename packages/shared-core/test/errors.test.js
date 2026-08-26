'use strict';
// test/errors.test.js — CLI 域错误契约
const {
  ERROR_CODES, EXIT_CODE_BY_PREFIX, exitCodeForCode, makeError, isDshError, isLauncherError
} = require('../contracts/errors');

describe('ERROR_CODES / 退出码映射', () => {
  it('35 个错误码全部带 ERR_ 前缀（32 基线 + M-36 ERR_ARG_BAD_STATE + ERR_AI_SESSION_WRITE + P3-8 ERR_STATE_WRITE）', () => {
    const codes = Object.values(ERROR_CODES);
    expect(codes).toHaveLength(35);
    for (const c of codes) expect(c.startsWith('ERR_')).toBe(true);
  });
  it('ERR_ARG_BAD_STATE 属参数域（exit=2，M-36 专属错误码）', () => {
    expect(ERROR_CODES.ERR_ARG_BAD_STATE).toBe('ERR_ARG_BAD_STATE');
    expect(exitCodeForCode('ERR_ARG_BAD_STATE')).toBe(2);
  });
  it('exitCodeForCode 按前缀推导（2-12）', () => {
    expect(exitCodeForCode('ERR_ARG_INVALID_ID')).toBe(2);
    expect(exitCodeForCode('ERR_ASSEMBLY_FIELD')).toBe(3);
    expect(exitCodeForCode('ERR_CONFLICT_VERSION')).toBe(4);
    expect(exitCodeForCode('ERR_YAML_PARSE')).toBe(5);
    expect(exitCodeForCode('ERR_INSTALL_FAILED')).toBe(6);
    expect(exitCodeForCode('ERR_HARNESS_NOT_FOUND')).toBe(7);
    expect(exitCodeForCode('ERR_LAUNCH_SPAWN')).toBe(8);
    expect(exitCodeForCode('ERR_HEAL_NO_ACTION')).toBe(9);
    expect(exitCodeForCode('ERR_LOCK_ACQUIRE')).toBe(10);
    expect(exitCodeForCode('ERR_STATE_WRITE')).toBe(10);
    expect(exitCodeForCode('ERR_LOG_WRITE')).toBe(11);
    expect(exitCodeForCode('ERR_ENV_UNSUPPORTED')).toBe(12);
    expect(exitCodeForCode('ERR_AI_SESSION_WRITE')).toBe(1); // RPC 域兜底
  });
  it('未知/空 code → 1', () => {
    expect(exitCodeForCode('FOO')).toBe(1);
    expect(exitCodeForCode(null)).toBe(1);
    expect(exitCodeForCode(undefined)).toBe(1);
    expect(exitCodeForCode('')).toBe(1);
  });
});

describe('makeError', () => {
  it('构造带 code/exitCode 的错误', () => {
    const err = makeError('ERR_ARG_INVALID_ID', 'bad id');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('ERR_ARG_INVALID_ID');
    expect(err.exitCode).toBe(2);
    expect(err.message).toBe('bad id');
  });
  it('extra 中的保留字段（exitCode/code/message）一律忽略', () => {
    const err = makeError('ERR_LAUNCH_EXIT', 'm', { exitCode: 1, code: 'ERR_HACK', message: 'x', childExitCode: 3, cause: new Error('c') });
    expect(err.exitCode).toBe(8);
    expect(err.code).toBe('ERR_LAUNCH_EXIT');
    expect(err.message).toBe('m');
    expect(err.childExitCode).toBe(3);
    expect(err.cause.message).toBe('c');
  });
  it('isDshError / isLauncherError', () => {
    expect(isDshError(makeError('ERR_LOCK_ACQUIRE', 'x'))).toBe(true);
    expect(isDshError(new Error('plain'))).toBe(false);
    expect(isDshError(null)).toBe(false);
    expect(isDshError('ERR_X')).toBe(false);
    expect(isLauncherError(makeError('ERR_YAML_INVALID', 'x'))).toBe(true);
  });
  it('M-37：makeError 拒绝未声明错误码（抛 TypeError，不静默）', () => {
    expect(() => makeError('ERR_NOT_DECLARED', 'x')).toThrow(TypeError);
    expect(() => makeError(null, 'x')).toThrow(TypeError);
    expect(() => makeError(undefined, 'x')).toThrow(TypeError);
    expect(() => makeError('ERR_LOCK_ACQUIRE', 'ok')).not.toThrow();
  });
  it('EXIT_CODE_BY_PREFIX 键与 ERROR_CODES 前缀一致', () => {
    for (const prefix of Object.keys(EXIT_CODE_BY_PREFIX)) {
      const has = Object.keys(ERROR_CODES).some((k) => k.startsWith(prefix));
      expect(has, prefix).toBe(true);
    }
  });
});
