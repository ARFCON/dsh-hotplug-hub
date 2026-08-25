'use strict';
// test/selfcheck-patch-lock.test.js — 四写者补丁锁（<profile>/.dsh-patch.lock）审计修复复现 + 回归
//
// 对应审计缺陷：launcher 写 cordis.patch.yml 的三处路径（syncProfile 整文件替换、
// applyExcludes 重写、heal 的 regenerate-patch）此前不取锁——契约常量 PATCH_LOCK_FILE
// （launcher/hotplug/dseam/C# 四写者共用）在 launcher 侧零引用，与 hub 并发写盘互相吞更新。
// 用例含【真实子进程持锁】的互斥验证与 hub 协议互认（shared fs/lock 单一实现）：
//   L5a 他进程持锁 → withPatchLock 按等待预算失败 ERR_LOCK_ACQUIRE（不永久阻塞）
//   L5b syncProfile 锁被外部持有 → 同步失败且 profile 不被半写
//   L5c syncProfile 正常路径取锁并释放（无残留锁文件）
//   L5d hub 侧锁 token（pid\nunix_ms）陈旧+pid 死 → launcher 立即接管（协议互认）
//   L5e heal regenerate-patch：锁 token 写失败 → ERR_LOCK_ACQUIRE（结构化错误，不裸抛）
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createCore } = require('../app/create-core');
const { syncProfile } = require('../infra/profile');
const { withPatchLock } = require('../infra/patch-lock');
const { executeAction } = require('../infra/heal-steps');
const { createFsPort } = require('../ports/fs');
const { tempDir, isolatedEnv } = require('./helpers');

const ROOT = path.join(__dirname, '..');

function makeCore(home) {
  return createCore({
    baseDir: ROOT,
    home,
    platform: 'win32',
    env: isolatedEnv(home),
    roots: {
      assemblyDir: path.join(home, 'assembly'),
      sandboxRoot: path.join(home, 'sandbox'),
      profilesRoot: path.join(home, '.dsh', 'profiles'),
      storeRoot: path.join(home, '.dsh', 'hotplug-store')
    }
  });
}

describe('L5：四写者补丁锁（launcher ↔ hub 互斥）', () => {
  /** 真实子进程持有 shared fs/lock 协议的锁（与 hub appendPatchBlock 同一实现）。 */
  const holdLockInChild = (lockPath, holdMs) => new Promise((resolve) => {
    const script = [
      "const fs = require('node:fs');",
      "const { acquireLock } = require('@dsh/shared-core/fs/lock');",
      `const a = acquireLock(fs, ${JSON.stringify(lockPath)}, { waitMs: 5000, refreshMs: 1000 });`,
      "if (!a.ok) process.exit(2);",
      "process.stdout.write('HELD');",
      `setTimeout(() => process.exit(0), ${holdMs});`
    ].join('\n');
    const child = spawn(process.execPath, ['-e', script], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v) } };
    child.stdout.on('data', (c) => { out += String(c); if (out.includes('HELD')) finish(child); });
    child.on('error', () => finish(null));
    child.on('exit', (code) => { if (code !== 0 || !out.includes('HELD')) finish(null) }); // 快速失败：取锁失败/异常退出不等超时
  });

  it('他进程持锁（真实子进程）→ withPatchLock 等待预算内失败 ERR_LOCK_ACQUIRE', async () => {
    const home = tempDir('sc-l5a-');
    const profileDir = path.join(home, '.dsh', 'profiles', 'demo');
    fs.mkdirSync(profileDir, { recursive: true });
    const lockPath = path.join(profileDir, '.dsh-patch.lock');
    const child = await holdLockInChild(lockPath, 2500);
    expect(child).toBeTruthy();
    const t0 = Date.now();
    const r = withPatchLock(require('node:fs'), profileDir, () => ({ ok: true }), { waitMs: 400 });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_LOCK_ACQUIRE');
    expect(Date.now() - t0).toBeLessThan(3000); // 按预算失败，不是永远阻塞
    try { child.kill(); } catch (_) { /* 已退出 */ }
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('syncProfile：锁被外部持有（真实子进程）→ 同步失败且 profile 不被半写', async () => {
    const home = tempDir('sc-l5b-');
    const core = makeCore(home);
    const id = 'demo';
    // 造 sandbox 产物（同步源）
    const sandboxDir = path.join(core.config.roots.sandboxRoot, id);
    fs.mkdirSync(sandboxDir, { recursive: true });
    fs.writeFileSync(path.join(sandboxDir, 'package.json'), JSON.stringify({ name: 'demo', dependencies: {} }));
    fs.writeFileSync(path.join(sandboxDir, 'cordis.patch.yml'), '[]');
    const profileDir = path.join(core.config.roots.profilesRoot, id);
    fs.mkdirSync(profileDir, { recursive: true });
    const child = await holdLockInChild(path.join(profileDir, '.dsh-patch.lock'), 2500);
    expect(child).toBeTruthy();
    const r = syncProfile(core, id, { patchLockWaitMs: 400 });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_LOCK_ACQUIRE');
    // 未拿到锁 → patch/manifest 均未被写入
    expect(fs.existsSync(path.join(profileDir, 'cordis.patch.yml'))).toBe(false);
    try { child.kill(); } catch (_) { /* 已退出 */ }
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('syncProfile：正常路径取锁并释放（无残留锁文件），patch 正确落地', () => {
    const home = tempDir('sc-l5c-');
    const core = makeCore(home);
    const id = 'demo';
    const sandboxDir = path.join(core.config.roots.sandboxRoot, id);
    fs.mkdirSync(sandboxDir, { recursive: true });
    fs.writeFileSync(path.join(sandboxDir, 'package.json'), JSON.stringify({ name: 'demo', dependencies: {} }));
    fs.writeFileSync(path.join(sandboxDir, 'cordis.patch.yml'), '[]');
    const r = syncProfile(core, id);
    expect(r.ok).toBe(true);
    const profileDir = path.join(core.config.roots.profilesRoot, id);
    expect(fs.existsSync(path.join(profileDir, 'cordis.patch.yml'))).toBe(true);
    expect(fs.existsSync(path.join(profileDir, '.dsh-patch.lock'))).toBe(false); // 锁已释放
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('锁协议与 hub 同源互认：hub 侧锁格式（pid\\nunix_ms）可被 launcher 接管（陈旧+pid 死）', () => {
    const home = tempDir('sc-l5d-');
    const profileDir = path.join(home, '.dsh', 'profiles', 'demo');
    fs.mkdirSync(profileDir, { recursive: true });
    const lockPath = path.join(profileDir, '.dsh-patch.lock');
    // 手写 hub 协议 token：pid=999999999（必然已死）+ 新时间戳 → launcher 立即接管
    fs.writeFileSync(lockPath, '999999999\n' + Date.now() + '\n');
    const r = withPatchLock(require('node:fs'), profileDir, () => ({ ok: true, done: true }), { waitMs: 1000 });
    expect(r.ok).toBe(true);
    expect(r.done).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('L5e heal regenerate-patch：锁 token 写失败 → ERR_LOCK_ACQUIRE（结构化错误，不裸抛）', async () => {
    const profile = tempDir('sc-l5e-');
    const badFs = createFsPort({
      ...fs,
      writeFileSync: () => { throw new Error('EACCES'); }
    });
    const core = { ports: { fs: badFs, registry: null } };
    const plugins = [{ id: 'p-a', name: 'a', version: '1.0.0', source: { type: 'npm' }, config: {}, resolvedVersion: '1.0.0' }];
    const r = await executeAction(core, { code: 'UTF8_CORRUPTION', steps: [{ type: 'regenerate-patch' }] }, { plugins, profile, state: { id: 'x' } });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_LOCK_ACQUIRE');
    fs.rmSync(profile, { recursive: true, force: true });
  });
});
