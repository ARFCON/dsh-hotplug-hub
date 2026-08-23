'use strict';
// test/qa3-store-atomic.test.js — store/atomic 强化（QA3 第 2 层主题 10）
// 原子写中途失败原文件完好 / 锁过期接管 / 锁等待超时 / 并发 withLock 串行化。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFileAtomic } = require('../infra/atomic');
const { writeState, readState, createEmptyState, mergeState, stateFilePath } = require('../infra/store');
const { acquireLock, releaseLock } = require('../infra/lock');
const { createFsPort } = require('../ports/fs');

const fsPort = createFsPort(fs);

function tmpDir(prefix = 'qa3-store-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('QA3 store/atomic 强化', () => {
  it('原子写中途失败（注入 rename 抛错）→ 原文件完好、tmp 清理', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'data.txt');
    fs.writeFileSync(file, 'ORIGINAL');
    // 包装 fs：renameSync 抛 EACCES
    const failingFs = {
      ...fsPort,
      renameSync: () => { const e = new Error('EACCES: rename'); e.code = 'EACCES'; throw e; }
    };
    const r = writeFileAtomic(failingFs, file, 'NEW DATA', { errorCode: 'ERR_INSTALL_FAILED' });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_INSTALL_FAILED');
    // 原文件完好
    expect(fs.readFileSync(file, 'utf8')).toBe('ORIGINAL');
    // tmp 被清理（同目录无 .tmp 残留）
    const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toHaveLength(0);
  });

  it('原子写中途失败（注入 writeFileSync 抛错）→ 原文件完好、tmp 清理', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'data.txt');
    fs.writeFileSync(file, 'ORIGINAL');
    const failingFs = {
      ...fsPort,
      writeFileSync: () => { const e = new Error('ENOSPC: no space'); e.code = 'ENOSPC'; throw e; }
    };
    const r = writeFileAtomic(failingFs, file, 'NEW', { errorCode: 'ERR_LOCK_ACQUIRE' });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_LOCK_ACQUIRE');
    expect(fs.readFileSync(file, 'utf8')).toBe('ORIGINAL');
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
  });

  it('锁过期接管：陈旧 token（已死 pid）→ 接管成功（H-4 文件锁）', () => {
    const dir = tmpDir();
    const lockPath = path.join(dir, '.lock');
    // 伪造已死持有者的新鲜 token → pid 探活立即判死 → 接管
    const gone = require('child_process').spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    fs.writeFileSync(lockPath, `${gone.pid}\n${Date.now()}\n`);
    const r = acquireLock(fsPort, lockPath, { waitMs: 1000, staleMs: 60000, owner: 'qa3-test' });
    expect(r.ok).toBe(true);
    const token = fs.readFileSync(lockPath, 'utf8').trim().split('\n');
    expect(token[0]).toBe(String(process.pid));
    releaseLock(fsPort, lockPath, { owner: 'qa3-test', pid: process.pid, fd: r.fd, refresh: r.refresh });
  });

  it('锁等待超时：锁被持有且未过期 → ERR_LOCK_ACQUIRE（exit=10）', () => {
    const dir = tmpDir();
    const lockPath = path.join(dir, '.lock');
    // 本进程持有（pid 存活 + token 新鲜）→ 另一 pid 获取超时
    fs.writeFileSync(lockPath, `${process.pid}\n${Date.now()}\n`);
    const r = acquireLock(fsPort, lockPath, { waitMs: 150, staleMs: 60000, pid: process.pid + 1 });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_LOCK_ACQUIRE');
    expect(r.error.exitCode).toBe(10);
    // 清理
    fs.unlinkSync(lockPath);
  });

  it('并发 acquire/release 串行化：持锁期间第二个 acquire 被拒（单进程同步语义）', () => {
    const dir = tmpDir();
    const lockPath = path.join(dir, '.lock');
    const r1 = acquireLock(fsPort, lockPath, { waitMs: 1000, staleMs: 60000, owner: 'first' });
    expect(r1.ok).toBe(true);
    // 同一进程内第二次 acquire（未过期，模拟另一调用方）→ 超时失败（证明锁串行互斥）
    const r2 = acquireLock(fsPort, lockPath, { waitMs: 150, staleMs: 60000, owner: 'second', pid: process.pid + 1 });
    expect(r2.ok).toBe(false);
    expect(r2.error.code).toBe('ERR_LOCK_ACQUIRE');
    releaseLock(fsPort, lockPath, { owner: 'first', pid: process.pid, fd: r1.fd, refresh: r1.refresh });
    // 释放后可再获取
    const r3 = acquireLock(fsPort, lockPath, { waitMs: 1000, staleMs: 60000, owner: 'third' });
    expect(r3.ok).toBe(true);
    releaseLock(fsPort, lockPath, { owner: 'third', pid: process.pid, fd: r3.fd, refresh: r3.refresh });
  });

  it('writeState：成功写入后可 readState 读回且 schemaVersion 正确', () => {
    const dir = tmpDir();
    const state = createEmptyState('demo');
    state.phase = 'CHECKED';
    const file = stateFilePath(dir, 'demo');
    const w = writeState(fsPort, file, state);
    expect(w.ok).toBe(true);
    const r = readState(fsPort, file);
    expect(r.ok).toBe(true);
    expect(r.state.phase).toBe('CHECKED');
    expect(r.state.schemaVersion).toBe(1);
  });

  it('readState：Windows 防病毒瞬时占用（EPERM）→ 有界重试后成功读取（不误判损坏）', () => {
    const dir = tmpDir();
    const file = stateFilePath(dir, 'demo');
    const state = createEmptyState('demo');
    state.phase = 'CHECKED';
    const w = writeState(fsPort, file, state);
    expect(w.ok).toBe(true);
    // 注入 fs 端口：前 2 次 readFileSync 抛 EPERM（模拟防病毒/过滤驱动瞬时占用刚落盘文件），之后放行
    let reads = 0;
    const flakyFs = {
      ...fsPort,
      readFileSync: (...args) => {
        reads += 1;
        if (reads <= 2) {
          const e = new Error('EPERM: operation not permitted, open (antivirus transient lock)');
          e.code = 'EPERM';
          throw e;
        }
        return fs.readFileSync(...args);
      }
    };
    const r = readState(flakyFs, file);
    expect(r.ok).toBe(true);
    expect(r.state.phase).toBe('CHECKED');
    expect(r.state.schemaVersion).toBe(1);
    expect(reads).toBe(3); // 2 次瞬态失败 + 1 次成功
  });

  it('readState：持久 EPERM → 有界重试耗尽后报错（不无限自旋，不掩盖损坏）', () => {
    const dir = tmpDir();
    const file = stateFilePath(dir, 'demo');
    const state = createEmptyState('demo');
    state.phase = 'CHECKED';
    const w = writeState(fsPort, file, state);
    expect(w.ok).toBe(true);
    let reads = 0;
    const stuckFs = {
      ...fsPort,
      readFileSync: () => {
        reads += 1;
        const e = new Error('EPERM: operation not permitted, open');
        e.code = 'EPERM';
        throw e;
      }
    };
    const r = readState(stuckFs, file);
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_ENV_UNSUPPORTED');
    expect(reads).toBe(5); // 默认 maxAttempts=5，重试耗尽即返回，不无限自旋
  });

  it('readState：非瞬态读错误（EISDIR）→ 不重试、立即报错', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'state.json');
    fs.writeFileSync(file, '{}', 'utf8');
    let reads = 0;
    const dirFs = {
      ...fsPort,
      readFileSync: () => {
        reads += 1;
        const e = new Error('EISDIR: illegal operation on a directory, read');
        e.code = 'EISDIR';
        throw e;
      }
    };
    const r = readState(dirFs, file);
    expect(r.ok).toBe(false);
    expect(reads).toBe(1); // 确定性错误绝不重试
  });

  it('readState：state.json 损坏 → 报错不覆盖（N33 实证）', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'state.json');
    fs.writeFileSync(file, '{broken json', 'utf8');
    const r = readState(fsPort, file);
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_ENV_UNSUPPORTED');
    // 文件未被覆盖
    expect(fs.readFileSync(file, 'utf8')).toBe('{broken json');
  });

  it('readState：schemaVersion 不匹配 → 报错', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'state.json');
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 999, id: 'x' }), 'utf8');
    const r = readState(fsPort, file);
    expect(r.ok).toBe(false);
  });

  it('mergeState：外部修正保留、heal 历史永不被覆盖（N34/X2 实证）', () => {
    const base = createEmptyState('demo');
    base.heal.history = [{ at: 't1', code: 'X', action: 'X', before: {}, after: {}, verified: true }];
    base.resolved.plugins = [{ id: 'a' }];
    const patched = mergeState(base, {
      resolved: { plugins: [{ id: 'b' }], conflicts: [], pinnedAt: 'now' },
      install: { status: 'ok', lastExit: 0, nodeModules: true },
      heal: { history: [{ evil: true }] }, // 尝试覆盖 heal → 必须被忽略
      phase: 'INSTALLED'
    });
    expect(patched.resolved.plugins).toEqual([{ id: 'b' }]); // resolved 被修正
    expect(patched.heal.history).toEqual(base.heal.history); // heal 历史保留
    expect(patched.install.status).toBe('ok');
    expect(patched.phase).toBe('INSTALLED');
  });

  it('computeFileSha256：存在返回哈希、不存在返回 null', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'f.txt');
    fs.writeFileSync(file, 'abc');
    const h = require('../infra/store').computeFileSha256(fsPort, file);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(require('../infra/store').computeFileSha256(fsPort, path.join(dir, 'missing'))).toBeNull();
  });
});
