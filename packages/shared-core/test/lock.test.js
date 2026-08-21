'use strict';
// test/lock.test.js — 统一文件锁（H-4/M-12）：互斥 / 探活 / token / 陈旧接管 /
// v1 迁移 / 他用户保守 / 释放校验
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawnSync } = require('child_process');
const {
  acquireLock, releaseLock, readToken, parseToken, formatToken, isStale, probePid, isDirectoryLock
} = require('../fs/lock');

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

function tempDir(prefix = 'shared-lock-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const childFixture = path.join(__dirname, 'fixtures', 'lock-child.cjs');

describe('token 协议', () => {
  it('formatToken / parseToken 往返（pid\nunix_ms）', () => {
    const t = formatToken(1234, 9876543210);
    expect(t).toBe('1234\n9876543210\n');
    const p = parseToken(t);
    expect(p).toEqual({ pid: 1234, at: 9876543210 });
    expect(parseToken('garbage')).toBe(null);
    expect(parseToken('123\nabc\n')).toBe(null);
    expect(parseToken('')).toBe(null);
    expect(parseToken('0\n1\n')).toBe(null);
  });
});

describe('acquire / release（单进程）', () => {
  it('获取→持有→释放', () => {
    const dir = tempDir();
    const lock = path.join(dir, '.lock');
    const a = acquireLock(nodeFs, lock, { waitMs: 500, refreshMs: 0 });
    expect(a.ok).toBe(true);
    expect(a.token.pid).toBe(process.pid);
    expect(fs.existsSync(lock)).toBe(true);
    const r = releaseLock(nodeFs, lock, { owner: a.owner, pid: process.pid, fd: a.fd });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('持锁期间二次获取失败（互斥）', () => {
    const dir = tempDir();
    const lock = path.join(dir, '.lock');
    const a = acquireLock(nodeFs, lock, { waitMs: 200, pollMs: 20, refreshMs: 0 });
    expect(a.ok).toBe(true);
    const b = acquireLock(nodeFs, lock, { waitMs: 200, pollMs: 20, refreshMs: 0, pid: process.pid + 1 });
    expect(b.ok).toBe(false);
    expect(b.error.code).toBe('ERR_LOCK_ACQUIRE');
    expect(b.error.exitCode).toBe(10);
    releaseLock(nodeFs, lock, { owner: a.owner, pid: process.pid, fd: a.fd });
  });

  it('释放时 token pid 不匹配拒绝（防误删他人锁）', () => {
    const dir = tempDir();
    const lock = path.join(dir, '.lock');
    const a = acquireLock(nodeFs, lock, { refreshMs: 0 });
    const r = releaseLock(nodeFs, lock, { owner: 'pid-other', pid: 999999, fd: a.fd });
    expect(r.ok).toBe(false);
    // 锁仍在
    expect(fs.existsSync(lock)).toBe(true);
    releaseLock(nodeFs, lock, { owner: a.owner, pid: process.pid, fd: a.fd });
  });

  it('pid 死（崩溃残留）→ 立即接管', () => {
    const dir = tempDir();
    const lock = path.join(dir, '.lock');
    // 先获取再释放一个子进程的 pid：用已退出子进程的 pid 伪造死锁持有者
    const gone = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    const deadPid = gone.pid;
    // 写入非常新的 token（时间戳为当前），但 pid 已死 → 仍应接管
    fs.writeFileSync(lock, formatToken(deadPid, Date.now()));
    const a = acquireLock(nodeFs, lock, { waitMs: 500, refreshMs: 0 });
    expect(a.ok).toBe(true);
    releaseLock(nodeFs, lock, { owner: a.owner, pid: process.pid, fd: a.fd });
  });

  it('token 陈旧（pid 存活但超时）→ 接管', () => {
    const dir = tempDir();
    const lock = path.join(dir, '.lock');
    // 用自己 pid 但 60s 前的 token（refreshMs=0 的持锁者若忘刷新即此形态）
    fs.writeFileSync(lock, formatToken(process.pid, Date.now() - 60000));
    const a = acquireLock(nodeFs, lock, { waitMs: 500, staleMs: 30000, refreshMs: 0 });
    expect(a.ok).toBe(true);
    releaseLock(nodeFs, lock, { owner: a.owner, pid: process.pid, fd: a.fd });
  });

  it('token 新鲜（pid 存活）→ 等待直至超时', () => {
    const dir = tempDir();
    const lock = path.join(dir, '.lock');
    const a = acquireLock(nodeFs, lock, { refreshMs: 0 });
    expect(a.ok).toBe(true);
    const start = Date.now();
    const b = acquireLock(nodeFs, lock, { waitMs: 300, staleMs: 30000, pollMs: 20, refreshMs: 0, pid: process.pid + 1 });
    expect(b.ok).toBe(false);
    expect(Date.now() - start).toBeGreaterThanOrEqual(250);
    releaseLock(nodeFs, lock, { owner: a.owner, pid: process.pid, fd: a.fd });
  });

  it('他用户 EACCES → 保守等待不接管', () => {
    const dir = tempDir();
    const lock = path.join(dir, '.lock');
    fs.writeFileSync(lock, formatToken(424242, Date.now()));
    // 模拟 EACCES：openSync 恒抛 EACCES
    const badFs = { ...nodeFs, openSync: () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; } };
    const start = Date.now();
    const r = acquireLock(badFs, lock, { waitMs: 250, staleMs: 30000, pollMs: 20, refreshMs: 0 });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_LOCK_ACQUIRE');
    expect(Date.now() - start).toBeGreaterThanOrEqual(200);
    expect(fs.existsSync(lock)).toBe(true); // 未被接管删除
  });

  it('token 缺失但 mtime 新 → 等待；mtime 旧 → 接管', () => {
    const dir = tempDir();
    const lock = path.join(dir, '.lock');
    fs.writeFileSync(lock, 'partial');
    const fresh = fs.statSync(lock).mtimeMs;
    expect(Date.now() - fresh).toBeLessThan(500);
    const b = acquireLock(nodeFs, lock, { waitMs: 150, staleMs: 30000, pollMs: 20, refreshMs: 0, pid: process.pid + 1 });
    expect(b.ok).toBe(false);
    // 伪造旧 mtime → 接管
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(lock, old, old);
    const c = acquireLock(nodeFs, lock, { waitMs: 500, staleMs: 30000, pollMs: 20, refreshMs: 0, pid: process.pid + 1 });
    expect(c.ok).toBe(true);
    releaseLock(nodeFs, lock, { owner: c.owner, pid: process.pid + 1, fd: c.fd });
  });

  it('父路径被文件占位（mkdir EEXIST）→ 立即报错，不无限自旋（回归：曾死循环）', () => {
    const dir = tempDir();
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    const lock = path.join(blocker, '.lock');
    const start = Date.now();
    const r = acquireLock(nodeFs, lock, { waitMs: 2000, staleMs: 30000, pollMs: 20, refreshMs: 0 });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_LOCK_ACQUIRE');
    expect(Date.now() - start).toBeLessThan(1000); // 立即返回，而非等到 waitMs
  });

  it('stat 失败路径受 deadline 约束（不无限自旋）', () => {
    const dir = tempDir();
    const lock = path.join(dir, '.lock');
    // openSync 恒 EEXIST + statSync 恒 ENOENT → 每次迭代走 stat-fail 分支
    const weirdFs = {
      ...nodeFs,
      openSync: () => { const e = new Error('EEXIST'); e.code = 'EEXIST'; throw e; },
      statSync: () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
    };
    const start = Date.now();
    const r = acquireLock(weirdFs, lock, { waitMs: 300, staleMs: 30000, pollMs: 20, refreshMs: 0 });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_LOCK_ACQUIRE');
    expect(Date.now() - start).toBeGreaterThanOrEqual(250);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('v1 目录锁迁移：持有者存活 → 等待；持有者已死 → 清理并接管', () => {
    const dir = tempDir();
    const lock = path.join(dir, '.lock');
    // 情形 A：v1 目录 + 存活 pid + 新时间 → 等待超时
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'owner'), JSON.stringify({ owner: `pid-${process.pid}`, at: new Date().toISOString() }));
    const b = acquireLock(nodeFs, lock, { waitMs: 150, staleMs: 30000, pollMs: 20, refreshMs: 0, pid: process.pid + 1 });
    expect(b.ok).toBe(false);
    expect(isDirectoryLock(nodeFs, lock)).toBe(true);
    // 清理情形 A 的 v1 目录，构造情形 B
    fs.rmSync(lock, { recursive: true, force: true });
    // 情形 B：v1 目录 + 已死 pid → 清理迁移为文件锁并获取
    fs.mkdirSync(lock);
    const gone = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    fs.writeFileSync(path.join(lock, 'owner'), JSON.stringify({ owner: `pid-${gone.pid}`, at: new Date().toISOString() }));
    const c = acquireLock(nodeFs, lock, { waitMs: 500, staleMs: 30000, pollMs: 20, refreshMs: 0, pid: process.pid + 1 });
    expect(c.ok).toBe(true);
    expect(isDirectoryLock(nodeFs, lock)).toBe(false);
    expect(readToken(nodeFs, lock).pid).toBe(process.pid + 1);
    releaseLock(nodeFs, lock, { owner: c.owner, pid: process.pid + 1, fd: c.fd });
  });
});

describe('跨进程互斥（真实子进程）', () => {
  it('两进程持锁窗口不重叠', () => {
    const dir = tempDir();
    const lock = path.join(dir, '.lock');
    const log = path.join(dir, 'events.log');
    const run = (owner, holdMs) => spawnSync(process.execPath, [childFixture, lock, String(holdMs), log, owner], { encoding: 'utf8' });
    const r1 = run('child-1', 400);
    const r2 = run('child-2', 400);
    expect(r1.status).toBe(0);
    expect(r2.status).toBe(0);
    const lines = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(4);
    // 顺序必须严格为 acquired/released 交替（互斥成立）
    const events = lines.map((l) => l.split(' ')[1]);
    expect(events).toEqual(['acquired', 'released', 'acquired', 'released']);
  });

  it('持有者存活时竞争者等待后成功（先来先得）', () => {
    const dir = tempDir();
    const lock = path.join(dir, '.lock');
    const log = path.join(dir, 'events2.log');
    // 子进程 1 持有 600ms；子进程 2 等待（waitMs 5000）后获取
    const r1 = spawnSync(process.execPath, [childFixture, lock, '600', log, 'hold-1'], { encoding: 'utf8' });
    const r2 = spawnSync(process.execPath, [childFixture, lock, '100', log, 'hold-2'], { encoding: 'utf8' });
    expect(r1.status).toBe(0);
    expect(r2.status).toBe(0);
    const events = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split(' ')[1]);
    expect(events).toEqual(['acquired', 'released', 'acquired', 'released']);
  });
});

describe('probePid / isStale', () => {
  it('probePid：自己存活 / 已死进程', () => {
    expect(probePid(process.pid)).toBe(0);
    const gone = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    expect(probePid(gone.pid)).toBe(1);
  });
  it('isStale 矩阵', () => {
    const now = Date.now();
    expect(isStale({ pid: process.pid, at: now }, now, 30000)).toBe(false);
    expect(isStale({ pid: process.pid, at: now - 60000 }, now, 30000)).toBe(true);
    const gone = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    expect(isStale({ pid: gone.pid, at: now }, now, 30000)).toBe(true); // pid 死 → 无视 token 年龄
    expect(isStale(null, now, 30000)).toBe(true);
  });
});
