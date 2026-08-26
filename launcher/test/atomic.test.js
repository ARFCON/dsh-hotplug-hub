'use strict';
// test/atomic.test.js — 原子写错误码语义（QA 观察 #6）
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFileAtomic } = require('../infra/atomic');
const { writeState } = require('../infra/store');
const { createFsPort } = require('../ports/fs');

const fsPort = createFsPort(fs);

describe('infra/atomic 错误码语义（QA #6 回归）', () => {
  it('writeFileAtomic 失败返回调用方指定的语义化错误码', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-atomic-'));
    const parentFile = path.join(dir, 'afile');
    fs.writeFileSync(parentFile, 'x'); // 父路径是文件 → mkdir 必然失败
    const r = writeFileAtomic(fsPort, path.join(parentFile, 'child.txt'), 'data', { errorCode: 'ERR_LOCK_ACQUIRE' });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_LOCK_ACQUIRE'); // 而非默认 ERR_LOG_WRITE
  });

  it('默认错误码为 ERR_INSTALL_FAILED（产物写失败）而非日志域', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-atomic-'));
    const parentFile = path.join(dir, 'afile');
    fs.writeFileSync(parentFile, 'x');
    const r = writeFileAtomic(fsPort, path.join(parentFile, 'child.txt'), 'data');
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_INSTALL_FAILED');
  });

  it('writeState 失败归状态持久化域 ERR_STATE_WRITE（exit=10，P3-8 语义纠正）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-atomic-'));
    const parentFile = path.join(dir, 'afile');
    fs.writeFileSync(parentFile, 'x');
    const r = writeState(fsPort, path.join(parentFile, 'state.json'), { schemaVersion: 1 });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_STATE_WRITE');
    expect(r.error.exitCode).toBe(10);
  });

  it('正常原子写成功且内容可读', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-atomic-'));
    const file = path.join(dir, 'out.txt');
    const r = writeFileAtomic(fsPort, file, 'hello', { errorCode: 'ERR_INSTALL_FAILED' });
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('hello');
    expect(fs.existsSync(file + '.tmp') || fs.readdirSync(dir).some((f) => f.endsWith('.tmp'))).toBe(false);
  });
});
