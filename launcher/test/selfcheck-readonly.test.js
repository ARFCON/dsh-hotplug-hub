'use strict';
// test/selfcheck-readonly.test.js — launcher 自检（check/status）审计修复复现 + 回归
//
// 每个用例对应一条审计确认的真实缺陷（修复前红、修复后绿）：
//   L1 stageCheck 不过滤 quarantined 插件 → 自愈后复检闸门永远红灯（check↔assemble 漂移）
//   L2 stageStatus healthy 漏报：install 失败 / 崩溃循环 / 隔离非空 / QUARANTINED 相位
//      均不影响判定（可产出 phase=QUARANTINED + STATUS OK 的自相矛盾输出）
//   L3 status 的 harness 探测（probe:false）与 launch 口径漂移：PATH 上的 dsh.cmd
//      报「未找到 harness」而 launch 成功（零子进程 PATH 扫描补齐）
//   L4 state.json 损坏把 check/status/logs 一并拦死（只读命令应诚实降级）
//   （四写者补丁锁的互斥/协议互认用例见 selfcheck-patch-lock.test.js）
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createCore } = require('../app/create-core');
const { STAGES } = require('../app/stages');
const { runPipeline } = require('../app/pipeline');
const { syncProfile } = require('../infra/profile');
const { withPatchLock } = require('../infra/patch-lock');
const { tempDir, isolatedEnv } = require('./helpers');

const ROOT = path.join(__dirname, '..');

function emptyState(id, overrides = {}) {
  return {
    schemaVersion: 1, id, assemblySha256: null, phase: 'IDLE',
    resolved: { plugins: [], conflicts: [], pinnedAt: null },
    install: { status: 'missing', lastExit: null, nodeModules: false },
    launch: { lastExit: null, lastStart: null, retries: 0, pid: null },
    heal: { history: [], quarantined: [] },
    rollback: { snapshot: null, lastRollbackAt: null },
    ...overrides
  };
}

function makeCore(home, opts = {}) {
  return createCore({
    baseDir: ROOT,
    home,
    // L3（PATH 扫描）传宿主平台（跨平台矩阵一致）；其余用例默认 win32 语义（纯 fs，平台无关）
    platform: opts.platform || 'win32',
    env: isolatedEnv(home),
    nowPort: opts.nowPort,
    roots: {
      assemblyDir: path.join(home, 'assembly'),
      sandboxRoot: path.join(home, 'sandbox'),
      profilesRoot: path.join(home, '.dsh', 'profiles'),
      storeRoot: path.join(home, '.dsh', 'hotplug-store')
    }
  });
}

/** 写一个 assembly（依赖图冲突形态：pkg-b 依赖 pkg-a@^2.0.0 而实际 1.0.0）。 */
function writeConflictAssembly(core, id = 'demo') {
  const dir = path.join(core.config.roots.assemblyDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'assembly.json'), JSON.stringify({
    hotpack: '1.0', id, name: 'd', version: '1.0.0',
    plugins: [
      { id: 'a', name: 'pkg-a', version: '1.0.0', source: { type: 'npm' }, config: {} },
      { id: 'b', name: 'pkg-b', version: '1.0.0', source: { type: 'npm' }, config: { dependencies: { 'pkg-a': '^2.0.0' } } }
    ]
  }));
  return dir;
}

describe('L1：stageCheck 消费隔离名单（与 assemble 同一过滤）', () => {
  it('冲突插件被 heal 隔离后 check 通过（复检闸门不再永远红灯）', async () => {
    const home = tempDir('sc-l1a-');
    const core = makeCore(home);
    writeConflictAssembly(core);
    const quarantined = emptyState('demo', { heal: { history: [], quarantined: ['pkg-b'] } });
    const r = await STAGES.check(core, quarantined, { id: 'demo' });
    expect(r.ok).toBe(true);
    expect(r.message).toContain('CHECK OK');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('未隔离时同一 assembly 仍报 ERR_CONFLICT_DEPENDENCY（过滤不是绕过）', async () => {
    const home = tempDir('sc-l1b-');
    const core = makeCore(home);
    writeConflictAssembly(core);
    const r = await STAGES.check(core, emptyState('demo'), { id: 'demo' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ERR_CONFLICT_DEPENDENCY');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('隔离名单里没有的冲突插件 → 依旧红灯（只剔除被点名者）', async () => {
    const home = tempDir('sc-l1c-');
    const core = makeCore(home);
    writeConflictAssembly(core);
    const r = await STAGES.check(core, emptyState('demo', { heal: { history: [], quarantined: ['pkg-unrelated'] } }), { id: 'demo' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ERR_CONFLICT_DEPENDENCY');
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('L2：stageStatus healthy 全因子判定（漏报根治）', () => {
  const setupHealthy = (core, id = 'demo') => {
    const assemblyDir = path.join(core.config.roots.assemblyDir, id);
    const sandboxDir = path.join(core.config.roots.sandboxRoot, id);
    const profileDir = path.join(core.config.roots.profilesRoot, id);
    for (const dir of [assemblyDir, sandboxDir, profileDir]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(assemblyDir, 'assembly.json'), '{}');
    fs.writeFileSync(path.join(sandboxDir, 'package.json'), '{}');
    fs.writeFileSync(path.join(profileDir, 'package.json'), '{}');
    fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '[]');
  };

  it('三件套完好 → STATUS OK（回归锚点：不因新因子误降级）', async () => {
    const home = tempDir('sc-l2a-');
    const core = makeCore(home);
    setupHealthy(core);
    const r = await STAGES.status(core, emptyState('demo'), { id: 'demo' });
    expect(r.ok).toBe(true);
    expect(r.data.healthy).toBe(true);
    expect(r.data.stateOk).toBe(true);
    expect(r.message).toBe('STATUS OK');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('install.status=failed（磁盘三件套仍在）→ DEGRADED + installOk:false', async () => {
    const home = tempDir('sc-l2b-');
    const core = makeCore(home);
    setupHealthy(core);
    const state = emptyState('demo', { install: { status: 'failed', lastExit: 1, nodeModules: false } });
    const r = await STAGES.status(core, state, { id: 'demo' });
    expect(r.data.healthy).toBe(false);
    expect(r.data.installOk).toBe(false);
    expect(r.message).toBe('STATUS DEGRADED');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('phase=QUARANTINED → DEGRADED（不再产出 QUARANTINED + STATUS OK 的矛盾输出）', async () => {
    const home = tempDir('sc-l2c-');
    const core = makeCore(home);
    setupHealthy(core);
    const state = emptyState('demo', { phase: 'QUARANTINED' });
    const r = await STAGES.status(core, state, { id: 'demo' });
    expect(r.data.healthy).toBe(false);
    expect(r.data.phase).toBe('QUARANTINED');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('隔离名单非空 → DEGRADED + quarantinedCount 如实', async () => {
    const home = tempDir('sc-l2d-');
    const core = makeCore(home);
    setupHealthy(core);
    const state = emptyState('demo', { heal: { history: [], quarantined: ['pkg-x'] } });
    const r = await STAGES.status(core, state, { id: 'demo' });
    expect(r.data.healthy).toBe(false);
    expect(r.data.quarantinedCount).toBe(1);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('活跃崩溃循环（retries≥3 且 MONITORING）→ DEGRADED；低于阈值不降级', async () => {
    const home = tempDir('sc-l2e-');
    const core = makeCore(home);
    setupHealthy(core);
    const crashing = emptyState('demo', { phase: 'MONITORING', launch: { lastExit: 1, lastStart: null, retries: 3, pid: null } });
    expect((await STAGES.status(core, crashing, { id: 'demo' })).data.healthy).toBe(false);
    const recovering = emptyState('demo', { phase: 'MONITORING', launch: { lastExit: 1, lastStart: null, retries: 2, pid: null } });
    expect((await STAGES.status(core, recovering, { id: 'demo' })).data.healthy).toBe(true);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('state._corrupted（损坏降级标记）→ healthy=false + stateOk:false 显式可见', async () => {
    const home = tempDir('sc-l2f-');
    const core = makeCore(home);
    setupHealthy(core);
    const state = emptyState('demo');
    state._corrupted = true;
    const r = await STAGES.status(core, state, { id: 'demo' });
    expect(r.data.healthy).toBe(false);
    expect(r.data.stateOk).toBe(false);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('L3：harness 探测口径对齐（零子进程 PATH 扫描）', () => {
  // core 的 platform 决定扫描的文件名集合（win32: dsh.cmd/dsh.exe；POSIX: dsh）——
  // 用例以宿主平台构造 core 并取同名文件，跨平台矩阵（CI ubuntu/macos/windows）一致。
  const makeCoreNative = (home) => makeCore(home, { platform: process.platform });

  it('probe:false 下 PATH 上的 dsh 可被发现（不再误报未找到）', () => {
    const home = tempDir('sc-l3a-');
    const binDir = path.join(home, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const fakeDsh = path.join(binDir, process.platform === 'win32' ? 'dsh.cmd' : 'dsh');
    fs.writeFileSync(fakeDsh, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n');
    if (process.platform !== 'win32') fs.chmodSync(fakeDsh, 0o755); // POSIX 惯例（扫描本身只看存在+校验）
    const core = makeCoreNative(home);
    core.config.env = { ...isolatedEnv(home), PATH: binDir };
    const { findHarness } = require('../infra/harness');
    const r = findHarness(core, { probe: false });
    expect(r.ok).toBe(true);
    expect(r.harness.toLowerCase()).toBe(fakeDsh.toLowerCase());
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('PATH 无 dsh 且候选缺失 → 仍如实未找到（回归锚点）', () => {
    const home = tempDir('sc-l3b-');
    const core = makeCoreNative(home);
    core.config.env = { ...isolatedEnv(home), PATH: path.join(home, 'empty') };
    const { findHarness } = require('../infra/harness');
    const r = findHarness(core, { probe: false });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_HARNESS_NOT_FOUND');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('PATH 上的零字节 dsh（劫持形态）→ 拒绝（N44 完整性校验仍生效）', () => {
    const home = tempDir('sc-l3c-');
    const binDir = path.join(home, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const fakeDsh = path.join(binDir, process.platform === 'win32' ? 'dsh.cmd' : 'dsh');
    fs.writeFileSync(fakeDsh, '');
    const core = makeCoreNative(home);
    core.config.env = { ...isolatedEnv(home), PATH: binDir };
    const { findHarness } = require('../infra/harness');
    const r = findHarness(core, { probe: false });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_HARNESS_UNTRUSTED');
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('L4：state.json 损坏——只读命令诚实降级（写命令仍拒绝）', () => {
  const corrupt = (core, id = 'demo') => {
    const storeDir = path.join(core.config.roots.storeRoot, id);
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(path.join(storeDir, 'state.json'), '{ "phase": "RUNN');
  };

  it('check：损坏不拦截（assembly 可读即可给出结论）', async () => {
    const home = tempDir('sc-l4a-');
    const core = makeCore(home);
    writeConflictAssembly(core);
    corrupt(core);
    const r = await runPipeline(core, 'check', { id: 'demo' });
    expect(r.ok).toBe(false); // 冲突仍在（修复前是 ERR_ENV_UNSUPPORTED，根本到不了冲突判定）
    expect(r.code).toBe('ERR_CONFLICT_DEPENDENCY');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('status：损坏 → DEGRADED + stateOk:false（不再拒答）', async () => {
    const home = tempDir('sc-l4b-');
    const core = makeCore(home);
    corrupt(core);
    const r = await runPipeline(core, 'status', { id: 'demo' });
    expect(r.ok).toBe(true);
    expect(r.data.healthy).toBe(false);
    expect(r.data.stateOk).toBe(false);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('logs：损坏不拦截（runlog 与 state 无关）', async () => {
    const home = tempDir('sc-l4c-');
    const core = makeCore(home);
    corrupt(core);
    const r = await runPipeline(core, 'logs', { id: 'demo', tail: 5 });
    expect(r.ok).toBe(true);
    expect(r.data.count).toBe(0);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('写命令（assemble）在损坏态仍硬失败（读-改-写不可信）', async () => {
    const home = tempDir('sc-l4d-');
    const core = makeCore(home);
    writeConflictAssembly(core);
    corrupt(core);
    const r = await runPipeline(core, 'assemble', { id: 'demo' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ERR_ENV_UNSUPPORTED');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('writeState 剥离 _corrupted/dirty 运行时注记（降级标记永不落盘）', () => {
    const home = tempDir('sc-l4e-');
    const core = makeCore(home);
    const stateFile = path.join(core.config.roots.storeRoot, 'demo', 'state.json');
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const state = emptyState('demo');
    state._corrupted = true;
    state.dirty = true;
    const w = core.infra.store.writeState(require('node:fs'), stateFile, state);
    expect(w.ok).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(persisted._corrupted).toBeUndefined();
    expect(persisted.dirty).toBeUndefined();
    expect(persisted.id).toBe('demo');
    fs.rmSync(home, { recursive: true, force: true });
  });
});
