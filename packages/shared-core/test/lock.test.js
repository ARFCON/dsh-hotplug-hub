'use strict';
// test/lock.test.js — 统一文件锁（H-4/M-12）：互斥 / 探活 / token / 陈旧接管 /
// v1 迁移 / 他用户保守 / 释放校验
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawnSync } = require('child_process');
const {
  acquireLock, releaseLock, readToken, parseToken, formatToken, rewriteToken, isStale, probePid, isDirectoryLock
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
    // 审计回归 #14：宽松 parseInt 曾把损坏 token 误判为有效 (pid,at)
    expect(parseToken('123abc\n456xyz\n')).toBe(null);
    expect(parseToken('1.5\n2\n')).toBe(null);
    expect(parseToken('  123  \n  456  \n')).toBe(null);
    expect(parseToken('999999999999999999999\n1\n')).toBe(null); // 超安全整数
    expect(parseToken('-1\n2\n')).toBe(null);
  });

  it('rewriteToken：先整体覆盖、后截断（杜绝"truncate→write"空文件窗口）', () => {
    const calls = [];
    const fakeFs = {
      writeSync: () => { calls.push('write'); return 8; },
      ftruncateSync: () => { calls.push('truncate'); }
    };
    rewriteToken(999, 42, { fsImpl: fakeFs, at: 123456 });
    // 关键断言：先 write 后 truncate。旧实现先 truncate 会在两步之间留出空 token 窗口，
    // 并发 readToken 读到空文件判损坏（flaky 根因）。
    expect(calls).toEqual(['write', 'truncate']);
  });

  it('rewriteToken：token 变短后无残留字节（精确截断）', () => {
    const dir = tempDir();
    const file = path.join(dir, 'token');
    const fd = fs.openSync(file, 'w');
    // 旧 token 更长（pid 位数更多）
    const longBuf = Buffer.from(formatToken(999999, 1700000000000), 'utf8');
    fs.writeSync(fd, longBuf, 0, longBuf.length, 0);
    // 用更短的新 token 重写
    const written = rewriteToken(fd, 1, { fsImpl: fs, at: 1700000000001 });
    expect(written).toBe('1\n1700000000001\n');
    fs.closeSync(fd);
    expect(fs.readFileSync(file, 'utf8')).toBe('1\n1700000000001\n');
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

  it('acquireLock 返回 refresh 句柄，releaseLock 传入后清理定时器（审计修复：防定时器泄漏）', () => {
    const dir = tempDir();
    const lock = path.join(dir, '.lock');
    // refreshMs>0 时 acquireLock 应返回 refresh 句柄（此前不返回，调用方直接 releaseLock
    // 无法清理 setInterval → 释放后仍每 10s 对已关闭 fd 写 token 泄漏）
    const a = acquireLock(nodeFs, lock, { waitMs: 500, refreshMs: 20 });
    expect(a.ok).toBe(true);
    expect(a.refresh).toBeTruthy();
    expect(typeof a.release).toBe('function');
    // 经 releaseLock 传入 refresh 释放 → 定时器被清理、锁文件删除
    const r = releaseLock(nodeFs, lock, { owner: a.owner, pid: process.pid, fd: a.fd, refresh: a.refresh });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
    // 释放后再次获取成功（无残留定时器干扰）
    const b = acquireLock(nodeFs, lock, { waitMs: 200, refreshMs: 0 });
    expect(b.ok).toBe(true);
    releaseLock(nodeFs, lock, { owner: b.owner, pid: process.pid, fd: b.fd, refresh: b.refresh });
  });

  it('持锁方阻塞（真实 spawnSync）期间 token 仍被 Worker 心跳刷新（P1：不被陈旧接管）', () => {
    const dir = tempDir();
    const lock = path.join(dir, '.lock');
    // 短 stale 窗口 + 短 refresh 周期，快速复现阻塞期陈旧
    const staleMs = 200;
    const refreshMs = 30;
    const a = acquireLock(nodeFs, lock, { waitMs: 500, staleMs, refreshMs, pollMs: 20 });
    expect(a.ok).toBe(true);
    // 主线程阻塞 > staleMs（真实 spawnSync 冻结事件循环，setInterval 无法触发）
    spawnSync(process.execPath, ['-e', 'const s=Date.now(); while(Date.now()-s<400){}'], { stdio: 'ignore' });
    const token = readToken(nodeFs, lock);
    expect(token).not.toBeNull();
    // P1 断言：Worker 线程在阻塞期间持续刷新 token → 仍新鲜（旧 setInterval 实现会陈旧）
    expect(isStale(token, Date.now(), staleMs)).toBe(false);
    releaseLock(nodeFs, lock, { owner: a.owner, pid: process.pid, fd: a.fd, refresh: a.refresh });
    // 释放后 Worker 已终止、锁文件删除
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('P1b：Worker 经持有 fd 写，释放后重建的锁文件不被旧 Worker 覆盖（跨线程覆盖竞态回归）', () => {
    const dir = tempDir();
    const lock = path.join(dir, '.lock');
    // A 持锁，Worker 心跳每 20ms 刷新，注入 pid=11111
    const a = acquireLock(nodeFs, lock, { waitMs: 500, refreshMs: 20, pid: 11111 });
    expect(a.ok).toBe(true);
    // 模拟竞态窗口：B 在 A 释放后立即接管（关 A 的 fd、删旧锁、写 B token）。
    // 故意【不】先 stop A 的 Worker——制造"旧 Worker 仍在运行"的最坏窗口。
    // 旧实现（每 tick fs.openSync(lockPath,'r+') 按路径重开）会打开 B 的新锁文件
    // 并用 11111 覆盖其 token；新实现（经持有 fd 写旧 inode）不影响 B 的锁文件。
    nodeFs.closeSync(a.fd);
    nodeFs.unlinkSync(lock);
    nodeFs.writeFileSync(lock, formatToken(22222, Date.now()));
    // 阻塞 > 数个 refreshMs 周期（真实 spawnSync 冻结主线程，让 Worker 有机会跑多个 tick）
    spawnSync(process.execPath, ['-e', 'const s=Date.now(); while(Date.now()-s<200){}'], { stdio: 'ignore' });
    const token = readToken(nodeFs, lock);
    expect(token).not.toBeNull();
    expect(token.pid).toBe(22222); // B 的 token 未被旧 Worker 覆盖（P1b 修复）
    // 清理：停止 A 的 Worker（其 fd 已关，写走 EBADF 分支，不影响 stop 语义）
    if (a.refresh && typeof a.refresh.stop === 'function') a.refresh.stop();
    if (fs.existsSync(lock)) fs.unlinkSync(lock);
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

  it('v1 目录锁迁移：fs 端口仅具 rmSync（缺 rmdirSync）也能清理接管（根治消费方端口缺口）', () => {
    const dir = tempDir();
    const lock = path.join(dir, '.lock');
    // 模拟 dseam-skillmcp / dsh-memory-hub 的直连端口：有 rmSync、无 rmdirSync
    const portWithoutRmdir = Object.fromEntries(
      Object.entries(nodeFs).filter(([k]) => k !== 'rmdirSync')
    );
    expect(portWithoutRmdir.rmSync).toBeTypeOf('function');
    expect(portWithoutRmdir.rmdirSync).toBeUndefined();
    // 已死 pid 的 v1 目录锁 → 应被 rmSync 清理并重建为文件锁
    fs.mkdirSync(lock);
    const gone = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    fs.writeFileSync(path.join(lock, 'owner'), JSON.stringify({ owner: `pid-${gone.pid}`, at: new Date().toISOString() }));
    const r = acquireLock(portWithoutRmdir, lock, { waitMs: 500, staleMs: 30000, pollMs: 20, refreshMs: 0, pid: process.pid + 1 });
    expect(r.ok).toBe(true);
    expect(isDirectoryLock(portWithoutRmdir, lock)).toBe(false);
    expect(readToken(portWithoutRmdir, lock).pid).toBe(process.pid + 1);
    releaseLock(portWithoutRmdir, lock, { owner: r.owner, pid: process.pid + 1, fd: r.fd });
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
