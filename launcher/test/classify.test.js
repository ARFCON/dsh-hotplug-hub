'use strict';
// test/classify.test.js — 结构化信号分类（J 回归：正常日志零误报）
const { classifySignal, classifyEntries } = require('../domain/classify');

describe('domain/classify 结构化信号分类（审计 J 回归）', () => {
  it('正常日志零误报（不再被宽正则误判为 AUTH_QUOTA）', () => {
    const r = classifySignal({ kind: 'stderr', line: 'INFO: AUTH service started, 401 connections open, network OK' });
    expect(r).toBeNull();
  });

  it('info 级日志不分类', () => {
    expect(classifySignal({ kind: 'log', severity: 'info', message: 'connected 401' })).toBeNull();
  });

  it('锚定 Error: ENOENT → LINK_FAIL', () => {
    const c = classifySignal({ kind: 'stderr', line: 'Error: ENOENT: no such file or directory, open ...' });
    expect(c).not.toBeNull();
    expect(c.action).toBe('LINK_FAIL');
  });

  it('锚定 Error: ETIMEDOUT → REGISTRY_UNAVAILABLE', () => {
    const c = classifySignal({ kind: 'stderr', line: 'Error: ETIMEDOUT connection timed out' });
    expect(c.action).toBe('REGISTRY_UNAVAILABLE');
  });

  it('spawn-error ENOENT → HARNESS_FIX（C3 修复：harness 缺失归因 harness 而非重装插件）', () => {
    const c = classifySignal({ kind: 'spawn-error', err: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) });
    expect(c.action).toBe('HARNESS_FIX');
  });

  it('exit 非零 → CRASH_LOOP；exit 零 → 无分类', () => {
    expect(classifySignal({ kind: 'exit', exitCode: 1 }).action).toBe('CRASH_LOOP');
    expect(classifySignal({ kind: 'exit', exitCode: 0 })).toBeNull();
  });

  it('error 级日志含 U+FFFD → UTF8_CORRUPTION（N36 联动）', () => {
    const c = classifySignal({ kind: 'log', severity: 'error', message: 'config 损坏 \uFFFD' });
    expect(c.action).toBe('UTF8_CORRUPTION');
  });

  it('classifyEntries 只处理 stderr/error 流并去重', () => {
    const entries = [
      { seq: 1, stream: 'stdout', line: 'INFO: AUTH started 401' },
      { seq: 2, stream: 'stderr', line: 'Error: ENOENT: missing' },
      { seq: 3, stream: 'stderr', line: 'Error: ENOENT: missing again' },
      { seq: 4, stream: 'error', line: 'spawn error' }
    ];
    const out = classifyEntries(entries);
    expect(out).toHaveLength(1);
    expect(out[0].action).toBe('LINK_FAIL');
  });
});
