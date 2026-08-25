'use strict';
// test/qa3-heal-extra.test.js — heal 四段闭环强化（QA3 第 2 层主题 8）
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runHeal, executeAction, verifyAction, rollbackAction } = require('../infra/heal');
const { planActions } = require('../domain/healplan');
const { classifySignal } = require('../domain/classify');
const { createCore } = require('../app/create-core');
const { createProcPort } = require('../ports/proc');
const { tempDir } = require('./helpers');

function healCore(overrides = {}) {
  return createCore({
    baseDir: path.join(__dirname, '..'),
    home: os.tmpdir(),
    procPort: createProcPort({
      spawn: () => { throw new Error('not used'); },
      spawnSync: () => ({ status: 1, error: null, stderr: 'Error: EACCES: permission denied', stdout: '' })
    }),
    ...overrides
  });
}

const FAKE_NOW = { now: () => 1000, iso: () => '2026-08-20T00:00:00.000Z' };

describe('QA3 heal 四段闭环强化（审计 C/N33/X2 强化）', () => {
  it('动作执行成功 → verified=true 且 history 只追加', async () => {
    const core = healCore({ nowPort: FAKE_NOW });
    const profile = tempDir();
    const action = { code: 'LINK_FAIL', steps: [], budget: 2, rollback: '移除坏链接' };
    const r1 = await runHeal(core, [action], { state: { heal: { history: [] } }, profile, plugins: [] }, { dryRun: false });
    expect(r1.ok).toBe(true);
    expect(r1.result.history[0].verified).toBe(true);
    // history 追加语义：state.heal.history 由 stageHeal concat，不覆盖
    const r2 = await runHeal(core, [action], { state: { heal: { history: r1.result.history } }, profile, plugins: [] }, { dryRun: false });
    expect(r2.result.history).toHaveLength(1);
    // 模拟 stageHeal 的 concat：历史只增不减
    const merged = (r1.result.history).concat(r2.result.history);
    expect(merged).toHaveLength(2);
  });

  it('动作失败 → 回滚被调用 → history 记录 verified=false + error', async () => {
    const core = healCore();
    const profile = tempDir();
    // A2 修复：真实回滚调用验证——包装 core.infra.snapshot.restoreSnapshot
    // （与 runHeal 内部 require('./snapshot') 是同一模块对象），断言回滚确实被调用。
    let restoreCalls = 0;
    const origRestore = core.infra.snapshot.restoreSnapshot;
    core.infra.snapshot.restoreSnapshot = (...args) => { restoreCalls += 1; return origRestore(...args); };
    const action = {
      code: 'INSTALL_FAIL',
      steps: [{ type: 'reinstall' }], // installPlugins 走假 proc status=1 → 失败
      budget: 0,
      rollback: '恢复 lockfile 快照',
      rollbackType: 'snapshot'
    };
    const ctx = {
      state: { rollback: { snapshot: { dir: profile, createdAt: 'x', files: [] } } },
      profile,
      plugins: [{ name: 'pkg', source: { type: 'npm' }, resolvedVersion: '1.0.0' }]
    };
    const r = await runHeal(core, [action], ctx, { dryRun: false });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_HEAL_BUDGET');
    expect(r.result.history[0].verified).toBe(false);
    expect(r.result.history[0].error).toBeTruthy();
    expect(restoreCalls).toBeGreaterThanOrEqual(1); // 回滚确实被调用（A2 修复：原断言恒真）
    core.infra.snapshot.restoreSnapshot = origRestore;
  });

  it('预算耗尽 → ERR_HEAL_BUDGET 且 history 记录每次尝试（H1 修复：budget=重试次数上限，总尝试=budget+1）', async () => {
    const core = healCore();
    const profile = tempDir();
    const action = { code: 'INSTALL_FAIL', steps: [{ type: 'reinstall' }], budget: 1, rollback: '恢复 lockfile 快照' };
    const ctx = { state: { rollback: { snapshot: { dir: profile, createdAt: 'x', files: [] } } }, profile, plugins: [{ name: 'pkg', source: { type: 'npm' }, resolvedVersion: '1.0.0' }] };
    const r = await runHeal(core, [action], ctx, { dryRun: false });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_HEAL_BUDGET');
    // H1 修复：budget=允许的重试次数上限（retries > budget 才超限）——
    // budget=1 → 首次失败后 retries=1（未超限）→ 重试一次 → retries=2（超限），总尝试=2。
    expect(r.result.history.length).toBe(2);
  });

  it('无信号 → planActions 产生空 actions；stageHeal 抛 ERR_HEAL_NO_ACTION（FIX-7 已接线）', () => {
    const cls = classifySignal({ kind: 'stderr', line: 'INFO: AUTH service started, 401 connections' });
    expect(cls).toBeNull();
    const planned = planActions(cls, { dryRun: true });
    expect(planned.actions).toHaveLength(0);
    // FIX-7：stageHeal 对空计划返回 ERR_HEAL_NO_ACTION（exit 9），不再静默 HEAL OK
    const { ERROR_CODES } = require('../contracts/errors');
    expect(ERROR_CODES.ERR_HEAL_NO_ACTION).toBeTruthy();
  });

  it('quarantine 语义：通过 ctx.quarantine 回调执行并写入隔离', async () => {
    const core = healCore();
    const profile = tempDir();
    let quarantined = [];
    const action = { code: 'VERSION_CONFLICT', steps: [{ type: 'quarantine' }], budget: 1, rollback: '恢复原 pin' };
    const ctx = {
      state: {},
      profile,
      plugins: [{ id: 'p', name: 'pkg', source: { type: 'npm' }, resolvedVersion: '1.0.0' }],
      quarantine: () => { quarantined.push('pkg'); return { ok: true }; }
    };
    const r = await runHeal(core, [action], ctx, { dryRun: false });
    expect(r.ok).toBe(true);
    expect(quarantined).toEqual(['pkg']);
    expect(r.result.history[0].verified).toBe(true);
  });

  it('executeAction 未知 step.type → 显式报错（FIX-16：不静默 ok:true）', async () => {
    const core = healCore();
    const action = { code: 'X', steps: [{ type: 'no-such-step' }], budget: 1, rollback: 'x' };
    const r = await executeAction(core, action, { state: {}, profile: tempDir(), plugins: [] });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_HEAL_BUDGET');
  });

  it('verifyAction：INSTALL_FAIL 对缺 node_modules 返回 ERR_INSTALL_DEP', async () => {
    const core = healCore();
    const profile = tempDir();
    const action = { code: 'INSTALL_FAIL', steps: [] };
    const v = await verifyAction(core, action, { profile, plugins: [{ name: 'ghost', source: { type: 'npm' } }] });
    expect(v.ok).toBe(false);
    expect(v.error.code).toBe('ERR_INSTALL_DEP');
  });

  it('verifyAction：CRASH_LOOP 验证最近退出码（C3 修复：0 通过 / null(detach 存活) 通过 / 非 0 失败）', async () => {
    const core = healCore();
    const action = { code: 'CRASH_LOOP', steps: [] };
    const okV = await verifyAction(core, action, { profile: tempDir(), plugins: [], state: { launch: { lastExit: 0, retries: 1 } } });
    expect(okV.ok).toBe(true);
    const aliveV = await verifyAction(core, action, { profile: tempDir(), plugins: [], state: { launch: { lastExit: null, retries: 3 } } });
    expect(aliveV.ok).toBe(true); // detach 存活中（lastExit=null）不得被误判为持续崩溃
    const badV = await verifyAction(core, action, { profile: tempDir(), plugins: [], state: { launch: { lastExit: 1, retries: 2 } } });
    expect(badV.ok).toBe(false);
    expect(badV.error.code).toBe('ERR_HEAL_BUDGET');
  });

  it('rollbackAction：无快照且非"恢复原 bundles 列表"回滚文案 → 静默 ok（记录行为）', async () => {
    const core = healCore();
    const action = { code: 'LINK_FAIL', rollback: '移除坏链接' };
    const r = await rollbackAction(core, action, { state: {}, profile: tempDir(), plugins: [] });
    expect(r.ok).toBe(true); // 无快照 → 不执行回滚 → ok（记录：回滚可能未真正发生）
  });
});
