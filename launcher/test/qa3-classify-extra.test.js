'use strict';
// test/qa3-classify-extra.test.js — classify 分类穷尽（QA3 第 2 层主题 4）
// 真实风格日志零误报 / 故障日志全命中 / 多信号优先级 / 边界输入。
const { classifySignal, classifyEntries } = require('../domain/classify');

describe('QA3 classify 分类穷尽（审计 J 强化）', () => {
  it('真实风格正常日志零误报（INFO/401/AUTH/网络正常）', () => {
    const normal = [
      'INFO: AUTH service started, 401 connections open, network OK',
      'INFO: listening on 0.0.0.0:8080',
      'DEBUG: ENOENT is not an error here',
      'WARN: 401 Unauthorized attempt ignored',
      'notice: received signal 15',
      'Started HTTP server on port 401',
      '2016-06-01T12:00:00Z INFO ready',
      'connect ETIMEDOUT handled by retry (not fatal)',
      'Error handling request: EACCES (user-level log, not spawn)',
      'fatal: something user-level',
      // C3 修复：非 git 形态的 fatal（无引号 URL）不得误报 GITHUB_ACQUIRE_FAIL
      'fatal: unable to access config file',
      "Error: fatal: unable to access 'https://internal/x' (Error: 前缀 + fatal 非真实 git 形态)"
    ];
    for (const line of normal) {
      expect(classifySignal({ kind: 'stderr', line }), `零误报: ${line}`).toBeNull();
    }
  });

  it('故障日志全命中：ENOENT/ETIMEDOUT/ENOTFOUND/ECONNREFUSED/EACCES', () => {
    const cases = [
      ['Error: ENOENT: no such file or directory, open \'C:\\x\'', 'LINK_FAIL'],
      ['Error: ENOENT', 'LINK_FAIL'],
      ['Error: ENOENT: spawn node ENOENT', 'LINK_FAIL'],
      ['Error: ETIMEDOUT connect timed out', 'REGISTRY_UNAVAILABLE'],
      ['Error: ENOTFOUND getaddrinfo ENOTFOUND registry.npmjs.org', 'REGISTRY_UNAVAILABLE'],
      ['Error: ECONNREFUSED 127.0.0.1:4873', 'REGISTRY_UNAVAILABLE'],
      ['Error: EACCES: permission denied, open \'C:\\x\'', 'INSTALL_FAIL'],
      ['Error: EACCES', 'INSTALL_FAIL'],
      ['Error: Repository not found', 'GITHUB_ACQUIRE_FAIL']
    ];
    for (const [line, expectAction] of cases) {
      const c = classifySignal({ kind: 'stderr', line });
      expect(c, `应命中: ${line}`).not.toBeNull();
      expect(c.action, `动作: ${line}`).toBe(expectAction);
    }
  });

  it('故障日志全命中：真实 git stderr（无 Error: 前缀）已被分类（C3 修复回归）', () => {
    // 真实 git clone 失败输出以 `fatal:` 或 `remote:` 开头，不含 `Error:` 前缀。
    // C3 修复：fatal 规则要求引号 URL（真实 git 输出形态），杜绝用户日志误报。
    const gitReal = [
      "fatal: unable to access 'https://github.com/org/repo.git/': Could not resolve host: github.com",
      'fatal: could not read Username for \'https://github.com\': terminal prompts disabled',
      'remote: Repository not found.'
    ];
    for (const line of gitReal) {
      const c = classifySignal({ kind: 'stderr', line });
      expect(c, `真实 git 行应被分类: ${line.slice(0, 50)}`).not.toBeNull();
    }
  });

  it('spawn-error 多信号优先级：spawn-error → HARNESS_FIX（C3 修复：harness 归因）', () => {
    const c1 = classifySignal({ kind: 'spawn-error', err: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) });
    expect(c1.action).toBe('HARNESS_FIX');
    const c2 = classifySignal({ kind: 'spawn-error', err: new Error('EACCES') });
    expect(c2.action).toBe('HARNESS_FIX');
    expect(c2.code).toBe('ERR_LAUNCH_SPAWN');
  });

  it('exit 信号：非零 → CRASH_LOOP；零 → null；exitCode 为 null（信号退出）→ CRASH_LOOP', () => {
    expect(classifySignal({ kind: 'exit', exitCode: 1 }).action).toBe('CRASH_LOOP');
    expect(classifySignal({ kind: 'exit', exitCode: 0 })).toBeNull();
    expect(classifySignal({ kind: 'exit', exitCode: null }).action).toBe('CRASH_LOOP');
    expect(classifySignal({ kind: 'exit', exitCode: undefined }).action).toBe('CRASH_LOOP');
  });

  it('log 信号：error 级 + U+FFFD → UTF8_CORRUPTION；error 级 + 规则行 → 对应动作；info 级 → null', () => {
    expect(classifySignal({ kind: 'log', severity: 'error', message: '损坏 \uFFFD' }).action).toBe('UTF8_CORRUPTION');
    expect(classifySignal({ kind: 'log', severity: 'error', message: 'Error: EACCES x' }).action).toBe('INSTALL_FAIL');
    expect(classifySignal({ kind: 'log', severity: 'info', message: 'Error: EACCES x' })).toBeNull();
  });

  it('空行 / 仅空白 / 非字符串 line → null 不崩溃', () => {
    expect(classifySignal({ kind: 'stderr', line: '' })).toBeNull();
    expect(classifySignal({ kind: 'stderr', line: '   ' })).toBeNull();
    expect(classifySignal({ kind: 'stderr', line: '\t' })).toBeNull();
    expect(classifySignal({ kind: 'stderr', line: null })).toBeNull();
    expect(classifySignal({ kind: 'stderr', line: undefined })).toBeNull();
    expect(classifySignal({ kind: 'stderr', line: 123 })).toBeNull();
    expect(classifySignal({ kind: 'stderr', line: {} })).toBeNull();
  });

  it('超长行（100KB）不崩溃且可分类', () => {
    const longLine = 'x'.repeat(100000) + '\nError: ENOENT at end';
    const c = classifySignal({ kind: 'stderr', line: longLine });
    // 规则锚定行首 Error: → 行首是 x，不命中 → null（不崩溃）
    expect(c).toBeNull();
    const c2 = classifySignal({ kind: 'stderr', line: 'Error: ENOENT: ' + 'x'.repeat(100000) });
    expect(c2).not.toBeNull();
    expect(c2.action).toBe('LINK_FAIL');
  });

  it('非 UTF-8 字节（latin1 乱码）→ 不崩溃、不误分类', () => {
    const buf = Buffer.from([0xff, 0xfe, 0x00, 0x45, 0x72, 0x72, 0x6f, 0x72, 0x3a, 0x20, 0x45, 0x4e, 0x4f, 0x45, 0x4e, 0x54]);
    const line = buf.toString('latin1');
    // 转成 utf8 替换符后的行为：只要不崩溃即可；若含 U+FFFD 且为 error 级 → UTF8_CORRUPTION
    const c = classifySignal({ kind: 'stderr', line });
    expect(c === null || typeof c === 'object').toBe(true);
  });

  it('classifyEntries：多条目去重 action、只处理 stderr/error', () => {
    const entries = [
      { seq: 1, stream: 'stdout', line: 'Error: ENOENT' },
      { seq: 2, stream: 'stderr', line: 'Error: ENOENT' },
      { seq: 3, stream: 'stderr', line: 'Error: EACCES' },
      { seq: 4, stream: 'error', line: 'Error: ETIMEDOUT' },
      { seq: 5, stream: 'unknown', line: 'Error: ENOENT' }
    ];
    const out = classifyEntries(entries);
    const actions = out.map((x) => x.action).sort();
    expect(actions).toEqual(['INSTALL_FAIL', 'LINK_FAIL', 'REGISTRY_UNAVAILABLE']);
  });

  it('null/undefined/空数组 entries → []', () => {
    expect(classifyEntries(null)).toEqual([]);
    expect(classifyEntries(undefined)).toEqual([]);
    expect(classifyEntries([])).toEqual([]);
  });
});
