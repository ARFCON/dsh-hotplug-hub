'use strict';
// test/heal.test.js — 自愈执行 + 验证 + 回滚 + 预算（C/N33/N34 回归）
const { runHeal } = require('../infra/heal');
const { planActions } = require('../domain/healplan');
const { classifySignal } = require('../domain/classify');
const { createCore } = require('../app/create-core');
const { createProcPort } = require('../ports/proc');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { tempDir } = require('./helpers');

// 使用假 proc 端口：npm 降级 install 恒失败（status 1），避免真实 npm 执行
function healCore() {
  return createCore({
    baseDir: path.join(__dirname, '..'),
    home: os.tmpdir(),
    procPort: createProcPort({
      spawn: () => { throw new Error('not used in heal test'); },
      spawnSync: () => ({ status: 1, error: null, stderr: 'Error: EACCES: permission denied', stdout: '' })
    })
  });
}

describe('infra/heal 自愈闭环（审计 C 回归）', () => {
  it('动作执行失败 → 回滚 → 超预算 ERR_HEAL_BUDGET', async () => {
    const core = healCore();
    const profile = tempDir();
    const action = {
      code: 'INSTALL_FAIL',
      steps: [{ type: 'reinstall' }],
      budget: 0,
      rollback: '恢复 lockfile 快照'
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
  });

  it('动作执行成功 → verified:true 写入历史', async () => {
    const core = healCore();
    const profile = tempDir();
    const action = { code: 'LINK_FAIL', steps: [], budget: 1, rollback: '移除坏链接' };
    const r = await runHeal(core, [action], { state: {}, profile, plugins: [] }, { dryRun: false });
    expect(r.ok).toBe(true);
    expect(r.result.history[0].verified).toBe(true);
    expect(r.result.actionCount).toBe(1);
  });

  it('dryRun 只记录不执行（默认预览语义）', async () => {
    const core = healCore();
    const profile = tempDir();
    const action = { code: 'CRASH_LOOP', steps: [{ type: 'rollback-snapshot' }], budget: 2, rollback: '恢复被禁用插件' };
    const r = await runHeal(core, [action], { state: {}, profile, plugins: [] }, { dryRun: true });
    expect(r.ok).toBe(true);
    expect(r.result.history[0].dryRun).toBe(true);
    expect(r.result.history[0].verified).toBe(false);
  });

  it('planActions 由分类结果生成动作（BUNDLE_MISCLASSIFY 等）', () => {
    const cls = classifySignal({ kind: 'stderr', line: 'Error: ENOENT: no such file or directory' });
    const planned = planActions(cls, { dryRun: true });
    expect(planned.actions.length).toBe(1);
    expect(planned.actions[0].code).toBe('LINK_FAIL');
    expect(planned.actions[0].budget).toBeGreaterThan(0);
    expect(planned.actions[0].verify.length).toBeGreaterThan(0);
    expect(planned.actions[0].rollback.length).toBeGreaterThan(0);
  });

  it('9 个自愈动作齐全且都带验证/回滚/预算（C3 修复：新增 HARNESS_FIX）', () => {
    const { allActionCodes, describeAction } = require('../domain/healplan');
    const codes = allActionCodes();
    expect(codes.sort()).toEqual([
      'BUNDLE_MISCLASSIFY', 'CRASH_LOOP', 'GITHUB_ACQUIRE_FAIL', 'HARNESS_FIX',
      'INSTALL_FAIL', 'LINK_FAIL', 'REGISTRY_UNAVAILABLE', 'UTF8_CORRUPTION', 'VERSION_CONFLICT'
    ]);
    for (const c of codes) {
      const a = describeAction(c);
      expect(a.verify.length).toBeGreaterThan(0);
      expect(a.rollback.length).toBeGreaterThan(0);
      expect(a.budget).toBeGreaterThan(0);
      expect(a.steps.length).toBeGreaterThan(0);
    }
  });
});
