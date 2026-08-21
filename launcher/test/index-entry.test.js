'use strict';
// test/index-entry.test.js — CLI 入口（index.js）契约测试（M-30 + C1）
// 覆盖：
//   - 模块化导入契约：仅导出 main/writeResult/setExit，require 无副作用（不注册信号、不改 exitCode）；
//   - writeResult 路由：--json 一律 stdout；文本模式成功 stdout / 失败 stderr；
//   - setExit 语义：设置 process.exitCode；
//   - 真实子进程端到端：--help（成功路径，exit 0 / stdout）、未知选项（文本模式 stderr / exit 2）、
//     --json 未知选项（stdout / exit 2）——隔离环境（DSH_HOME 指向临时目录）下运行，红线不触碰真实 harness。
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');
const { isolatedEnv, tempDir } = require('./helpers');

const LAUNCHER_ROOT = path.join(__dirname, '..');
const INDEX = path.join(LAUNCHER_ROOT, 'index.js');
const { main, writeResult, setExit } = require('../index');

describe('index.js CLI 入口（M-30 模块化契约）', () => {
  it('导出 main/writeResult/setExit 三个函数（M-30）', () => {
    expect(typeof main).toBe('function');
    expect(typeof writeResult).toBe('function');
    expect(typeof setExit).toBe('function');
  });

  it('require 无副作用：不注册信号处理器、不修改 process.exitCode', () => {
    // require 前快照（本文件顶部已 require；此处对同一模块缓存再做一次断言）
    const beforeSigint = process.listenerCount('SIGINT');
    const beforeSigterm = process.listenerCount('SIGTERM');
    const beforeExitCode = process.exitCode;
    delete require.cache[require.resolve('../index')];
    require('../index');
    expect(process.listenerCount('SIGINT')).toBe(beforeSigint);
    expect(process.listenerCount('SIGTERM')).toBe(beforeSigterm);
    expect(process.exitCode).toBe(beforeExitCode);
  });

  it('writeResult：--json 模式成功/失败一律写 stdout（C1 机器可读契约）', () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      writeResult({ ok: true, code: null, message: 'ok', data: null, exitCode: 0 }, { json: true });
      expect(out).toHaveBeenCalled();
      expect(err).not.toHaveBeenCalled();
      out.mockClear();

      writeResult({ ok: false, code: 'ERR_ARG_BAD_OPTION', message: '未知选项', data: null, exitCode: 2 }, { json: true });
      expect(out).toHaveBeenCalled();
      expect(err).not.toHaveBeenCalled();
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });

  it('writeResult：文本模式成功写 stdout、失败写 stderr（C1）', () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      writeResult({ ok: true, code: null, message: 'ok', data: null, exitCode: 0 }, {});
      expect(out).toHaveBeenCalled();
      expect(err).not.toHaveBeenCalled();
      out.mockClear();

      writeResult({ ok: false, code: 'ERR_ARG_BAD_OPTION', message: '未知选项', data: null, exitCode: 2 }, {});
      expect(err).toHaveBeenCalled();
      expect(out).not.toHaveBeenCalled();
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });

  it('setExit：设置 process.exitCode（不立即终止，事件循环可排空输出）', () => {
    const saved = process.exitCode;
    try {
      setExit(7);
      expect(process.exitCode).toBe(7);
    } finally {
      process.exitCode = saved;
    }
  });
});

describe('index.js 真实子进程端到端（隔离环境）', () => {
  const home = tempDir('index-entry-');
  const env = isolatedEnv(home);

  function runCli(args) {
    return new Promise((resolve, reject) => {
      execFile(process.execPath, [INDEX, ...args], { cwd: LAUNCHER_ROOT, env, timeout: 20000 }, (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : (error.code || 1)) : 0,
          stdout,
          stderr
        });
      });
    });
  }

  it('--help：成功路径 exit 0，用法输出到 stdout', async () => {
    const r = await runCli(['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/用法|Usage|assemble/);
    expect(r.stderr).toBe('');
  });

  it('未知选项：文本模式 ERR_ARG_BAD_OPTION（exit 2），错误消息到 stderr', async () => {
    const r = await runCli(['--bogus-flag']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/未知选项/);
    expect(r.stdout).toBe('');
  });

  it('未知选项 + --json：错误结果走 stdout（机器可读），exit 2', async () => {
    const r = await runCli(['--json', '--bogus-flag']);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain('ERR_ARG_BAD_OPTION');
    expect(r.stderr).toBe('');
  });

  it('--help --json：成功结果 JSON 走 stdout，exit 0', async () => {
    const r = await runCli(['--json', '--help']);
    expect(r.code).toBe(0);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
    expect(r.stderr).toBe('');
  });

  it('--timeout 缺值：ERR_ARG_BAD_OPTION（exit 2），不触碰真实 harness', async () => {
    const r = await runCli(['--timeout']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/ERR_ARG_BAD_OPTION|--timeout/);
    // 隔离红线：临时 home 下不应产生任何真实 dsh 目录
    expect(fs.existsSync(path.join(home, '.dsh'))).toBe(false);
  });

  it('清理：隔离目录可删除', () => {
    expect(fs.rmSync(home, { recursive: true, force: true })).toBeUndefined();
    expect(fs.existsSync(home)).toBe(false);
  });
});
