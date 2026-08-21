'use strict';
// test/atomic.test.js — 原子写（随机 tmp + wx + rename + 失败清理）
const path = require('path');
const os = require('os');
const fs = require('fs');
const { writeFileAtomic } = require('../fs/atomic');

const nodeFs = {
  readFileSync: fs.readFileSync.bind(fs),
  writeFileSync: fs.writeFileSync.bind(fs),
  appendFileSync: fs.appendFileSync.bind(fs),
  existsSync: fs.existsSync.bind(fs),
  mkdirSync: fs.mkdirSync.bind(fs),
  rmdirSync: fs.rmdirSync.bind(fs),
  copyFileSync: fs.copyFileSync.bind(fs),
  renameSync: fs.renameSync.bind(fs),
  readdirSync: fs.readdirSync.bind(fs),
  statSync: fs.statSync.bind(fs),
  lstatSync: fs.lstatSync.bind(fs),
  readSync: fs.readSync.bind(fs),
  writeSync: fs.writeSync.bind(fs),
  ftruncateSync: fs.ftruncateSync.bind(fs),
  unlinkSync: fs.unlinkSync.bind(fs),
  rmSync: fs.rmSync.bind(fs),
  openSync: fs.openSync.bind(fs),
  closeSync: fs.closeSync.bind(fs),
  fsyncSync: fs.fsyncSync.bind(fs),
  symlinkSync: fs.symlinkSync.bind(fs),
  realpathSync: fs.realpathSync.bind(fs)
};

function tempDir(prefix = 'shared-atomic-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('writeFileAtomic', () => {
  it('成功写入并返回字节数', () => {
    const dir = tempDir();
    const file = path.join(dir, 'a', 'b', 'x.txt');
    const r = writeFileAtomic(nodeFs, file, 'hello', {});
    expect(r.ok).toBe(true);
    expect(r.bytes).toBe(5);
    expect(fs.readFileSync(file, 'utf8')).toBe('hello');
  });

  it('失败不留半截文件 / 不残留 tmp', () => {
    const dir = tempDir();
    const file = path.join(dir, 'x.txt');
    // 目标目录不存在且无法创建（用文件占位目录）
    const blocker = path.join(dir, 'sub');
    fs.mkdirSync(blocker);
    fs.writeFileSync(path.join(blocker, 'x.txt'), 'data');
    const r = writeFileAtomic(nodeFs, path.join(blocker, 'x.txt', 'y.txt'), 'x', {});
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_INSTALL_FAILED');
    const leftovers = fs.readdirSync(blocker).filter((f) => f.includes('.tmp'));
    expect(leftovers).toHaveLength(0);
  });

  it('errorCode 可定制', () => {
    const dir = tempDir();
    const file = path.join(dir, 'sub', 'x.txt');
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(file, 'data');
    const r = writeFileAtomic(nodeFs, path.join(dir, 'sub', 'x.txt', 'nested'), 'x', { errorCode: 'ERR_LOCK_ACQUIRE' });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_LOCK_ACQUIRE');
  });

  it('并发写同一目标：最终内容为某一次完整写入（无撕裂）', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'c.txt');
    const payloads = [];
    for (let i = 0; i < 12; i += 1) payloads.push('line-' + i + '-' + 'x'.repeat(2000) + '\n');
    const results = await Promise.all(payloads.map((p) => new Promise((resolve) => {
      setImmediate(() => resolve(writeFileAtomic(nodeFs, file, p, {})));
    })));
    expect(results.every((r) => r.ok)).toBe(true);
    const final = fs.readFileSync(file, 'utf8');
    expect(payloads).toContain(final);
    // 无 tmp 残留
    expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp'))).toHaveLength(0);
  });

  it('mode 生效（0600 state 场景）', () => {
    const dir = tempDir();
    const file = path.join(dir, 's.json');
    writeFileAtomic(nodeFs, file, '{}', { mode: 0o600 });
    if (process.platform !== 'win32') {
      const st = fs.statSync(file);
      expect(st.mode & 0o777).toBe(0o600);
    }
  });
});
