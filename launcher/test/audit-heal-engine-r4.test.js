'use strict';
// test/audit-heal-engine-r4.test.js — 「自检自愈」引擎深度审计（R4，A 部分）
//
// 每条测试标注「钉死什么契约/缺陷」。失败测试=证明真实缺陷；通过测试=钉死正确行为。
// 覆盖疑点（A 部分）：1 预算 off-by-one / 2 CRASH_LOOP 无快照 / 3 幻影自愈 /
// 4 dryRun 零副作用 / 5 verify 失败回滚 / 6 rollbackAction 声明却不回滚。
const fs = require('fs');
const path = require('path');
const { classifySignal, classifyEntries, classifyStateSignals } = require('../domain/classify');
const { describeAction, planActions } = require('../domain/healplan');
const { executeAction } = require('../infra/heal-steps');
const { verifyAction, rollbackAction } = require('../infra/heal-verify');
const { runHeal } = require('../infra/heal');
const { createFsPort } = require('../ports/fs');
const { createSnapshot } = require('../infra/snapshot');
const { tempDir, isolatedEnv } = require('./helpers');

const fsPort = createFsPort(fs);

function makeCore(overrides = {}) {
  return {
    ports: {
      fs: fsPort,
      registry: null,
      now: { now: () => 1000, iso: () => '2026-08-20T00:00:00.000Z' }
    },
    infra: { harness: { findHarness: () => ({ ok: true, harness: '/fake/harness' }) } },
    ...overrides
  };
}

const npmPlugin = (name, version, extra = {}) => ({
  id: `p-${name}`,
  name,
  version,
  source: { type: 'npm' },
  config: {},
  resolvedVersion: null,
  pinned: false,
  installPath: null,
  ref: null,
  ...extra
});

// 让一个 Promise 落地为 {resolved, value|error}，用于「不得裸抛」的契约断言
function settle(p) {
  return p.then(
    (value) => ({ resolved: true, value }),
    (error) => ({ resolved: false, error })
  );
}

// =====================================================================
// 疑点 1：预算语义（off-by-one）
// =====================================================================
describe('R4-1 预算语义（retries > budget 边界）', () => {
  const alwaysFailAction = (budget) => ({
    code: 'CRASH_LOOP',
    steps: [{ type: 'no-such-step' }], // 未知步骤 → 恒失败（ERR_HEAL_BUDGET）
    budget,
    rollback: '恢复被禁用插件'
  });

  it('H1 修复后钉死：budget 0/1/2/3 → 总尝试次数 1/2/3/4（budget=重试次数上限，总尝试=budget+1）', async () => {
    for (const [budget, expected] of [[0, 1], [1, 2], [2, 3], [3, 4]]) {
      const r = await runHeal(makeCore(), [alwaysFailAction(budget)],
        { state: {}, profile: tempDir(`r4-budget-${budget}-`), plugins: [] }, { dryRun: false });
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('ERR_HEAL_BUDGET');
      expect(r.result.history.length, `budget=${budget} 应产生 ${expected} 次尝试`).toBe(expected);
    }
  });

  it('budget=1 → 允许 1 次重试（2 次总尝试）；budget=0 → 0 次重试（1 次总尝试）', async () => {
    const r = await runHeal(makeCore(), [alwaysFailAction(1)],
      { state: {}, profile: tempDir('r4-budget1-'), plugins: [] }, { dryRun: false });
    expect(r.result.history.length).toBe(2);
  });
});

// =====================================================================
// 疑点 2：CRASH_LOOP 无快照场景（rollback-snapshot 不得阻断 disable-recent）
// =====================================================================
describe('R4-2 CRASH_LOOP 无快照：实质修复步骤被 rollback-snapshot 阻断', () => {
  it('H2 修复后：无快照时 disable-recent（隔离最近插件）仍执行，回滚快照失败不阻断', async () => {
    const quarantine = vi.fn(() => ({ ok: true }));
    const plugins = [npmPlugin('pkg-a', '1.0.0')];
    const state = { launch: { lastExit: 1, retries: 3 }, heal: { quarantined: [] }, resolved: { plugins } };
    const action = describeAction('CRASH_LOOP'); // steps=[rollback-snapshot, disable-recent], budget=2
    const r = await runHeal(makeCore(), [action],
      { state, profile: tempDir('r4-crash-'), plugins, quarantine }, { dryRun: false });
    expect(quarantine).toHaveBeenCalledWith('pkg-a');
    expect(r.ok).toBe(true);
    expect(state.launch.lastExit).toBeNull();
    expect(state.launch.retries).toBe(0);
  });
});

// =====================================================================
// 疑点 3：幻影自愈（since 过滤漏洞）
// =====================================================================
describe('R4-3 幻影自愈（since 过滤）', () => {
  const { createCore } = require('../app/create-core');
  const { createProcPort } = require('../ports/proc');
  const { stageHeal } = require('../app/stages-heal');
  const { runLogFileFor } = require('../app/stages-util');

  function healStageCore() {
    const home = tempDir('r4-stage-');
    const core = createCore({
      baseDir: path.join(__dirname, '..'),
      home,
      env: isolatedEnv(home),
      procPort: createProcPort({ spawn: () => { throw new Error('no spawn'); }, spawnSync: () => ({ status: 1, error: null, stderr: '', stdout: '' }) })
    });
    return { core, home };
  }
  const sandboxFor = (core, id) => path.join(core.config.roots.sandboxRoot, id);

  it('H3 修复后：无有效时间戳的陈旧日志行被排除（fail-closed），不触发幻影 LINK_FAIL', async () => {
    const { core, home } = healStageCore();
    const id = 'r4-phantom-a';
    const logFile = runLogFileFor(core, id);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, JSON.stringify({ seq: 1, stream: 'stderr', line: 'Error: ENOENT: no such file or directory' }) + '\n');
    const state = { id, phase: 'LAUNCHED', launch: { lastExit: 0, retries: 0, lastStart: new Date().toISOString() }, heal: {}, resolved: { plugins: [] } };
    try {
      const r = await stageHeal(core, state, { id, yes: false });
      expect(r.ok).toBe(false);
      expect(r.code).toBe('ERR_HEAL_NO_ACTION');
    } finally {
      fs.rmSync(sandboxFor(core, id), { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('H3 修复后：reassemble 后 lastStart=null → 不分类任何历史日志行 → 无幻影', async () => {
    const { core, home } = healStageCore();
    const id = 'r4-phantom-b';
    const logFile = runLogFileFor(core, id);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const oldT = new Date(Date.now() - 3600 * 1000).toISOString();
    fs.writeFileSync(logFile, JSON.stringify({ seq: 1, t: oldT, stream: 'stderr', line: 'Error: ENOENT: no such file' }) + '\n');
    const state = { id, phase: 'LAUNCHED', launch: { lastExit: null, lastStart: null, retries: 0 }, heal: {}, resolved: { plugins: [] } };
    try {
      const r = await stageHeal(core, state, { id, yes: false });
      expect(r.ok).toBe(false);
      expect(r.code).toBe('ERR_HEAL_NO_ACTION');
    } finally {
      fs.rmSync(sandboxFor(core, id), { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('证实：classifyStateSignals 不受 since 过滤（读取当前 state.launch，非幻影源）', () => {
    expect(classifyStateSignals({ launch: { lastExit: 1, retries: 3 } }).map((x) => x.action)).toEqual(['CRASH_LOOP']);
    expect(classifyStateSignals({ launch: { lastExit: 0, retries: 0 } })).toEqual([]);
  });
});

// =====================================================================
// 疑点 4：dryRun 零副作用契约 + history 结构一致性
// =====================================================================
describe('R4-4 dryRun 零持久副作用', () => {
  const { createCore } = require('../app/create-core');
  const { createProcPort } = require('../ports/proc');
  const { stageHeal } = require('../app/stages-heal');
  const { runLogFileFor } = require('../app/stages-util');

  it('证实：预览（无 --yes）不落 run.jsonl / 不建 profile / state 零变更（C7 契约）', async () => {
    const home = tempDir('r4-dryrun-');
    const core = createCore({
      baseDir: path.join(__dirname, '..'),
      home,
      env: isolatedEnv(home),
      procPort: createProcPort({ spawn: () => { throw new Error('no spawn'); }, spawnSync: () => ({ status: 1, error: null, stderr: '', stdout: '' }) })
    });
    const id = 'r4-dryrun-a';
    const logFile = runLogFileFor(core, id);
    const state = { id, phase: 'LAUNCHED', launch: { lastExit: 1, retries: 3, lastStart: new Date().toISOString() }, heal: {}, resolved: { plugins: [npmPlugin('pkg-a', '1.0.0')] } };
    const before = JSON.stringify(state);
    const r = await stageHeal(core, state, { id, yes: false });
    expect(r.ok).toBe(true);
    expect(r.data.actions).toContain('CRASH_LOOP');
    expect(JSON.stringify(state)).toBe(before);
    expect(fs.existsSync(logFile)).toBe(false);
    expect(fs.existsSync(path.join(core.config.roots.profilesRoot, id))).toBe(false);
    fs.rmSync(path.join(core.config.roots.sandboxRoot, id), { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('记录：dryRun history 条目含 dryRun:true 标记，与非 dryRun 结构略有差异（非缺陷）', async () => {
    const action = { code: 'LINK_FAIL', steps: [], budget: 1, rollback: '移除坏链接' };
    const dry = await runHeal(makeCore(), [action], { state: {}, profile: tempDir('r4-dryrun-b-'), plugins: [] }, { dryRun: true });
    const wet = await runHeal(makeCore(), [action], { state: {}, profile: tempDir('r4-dryrun-c-'), plugins: [] }, { dryRun: false });
    expect(Object.keys(dry.result.history[0]).sort()).toEqual(['action', 'at', 'code', 'dryRun', 'verified']);
    expect(Object.keys(wet.result.history[0]).sort()).toEqual(['action', 'at', 'code', 'verified']);
    expect(dry.result.history[0].verified).toBe(false);
    expect(wet.result.history[0].verified).toBe(true);
  });
});

// =====================================================================
// 疑点 5：verify 失败 → rollbackAction → 回滚失败/成功路径
// =====================================================================
describe('R4-5 verify 失败回滚路径', () => {
  it('证实：verify 失败但回滚成功 → 按预算重试，history 每条 verified:false', async () => {
    const action = { code: 'CRASH_LOOP', steps: [], budget: 2, rollback: '恢复被禁用插件' };
    const state = { launch: { lastExit: 5, retries: 3 }, rollback: { snapshot: null } };
    const r = await runHeal(makeCore(), [action], { state, profile: tempDir('r4-verify-retry-'), plugins: [] }, { dryRun: false });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_HEAL_BUDGET');
    expect(r.result.history.length).toBe(3); // budget=2 → 2 次重试 = 3 次总尝试（H1 修复）
    expect(r.result.history.every((h) => h.verified === false)).toBe(true);
  });

  it('证实：verify 失败且回滚失败 → 立即终止，history 仅 1 条，不静默重试', async () => {
    const snapshot = { dir: tempDir('r4-verify-rb-'), createdAt: 'x', externalDir: null, files: [{ rel: 'x.bin', hash: 'x', external: true, type: 'file' }] };
    const action = { code: 'CRASH_LOOP', steps: [], budget: 3, rollback: '恢复被禁用插件', rollbackType: 'snapshot' };
    const state = { launch: { lastExit: 5, retries: 3 }, rollback: { snapshot } };
    const r = await runHeal(makeCore(), [action], { state, profile: tempDir('r4-verify-rb2-'), plugins: [] }, { dryRun: false });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_HEAL_BUDGET');
    expect(r.result.history.length).toBe(1);
    expect(r.result.history[0].verified).toBe(false);
  });
});

// =====================================================================
// 疑点 6：rollbackAction 语义（声明了 rollback 却不回滚）
// =====================================================================
describe('R4-6 rollbackAction 声明却不回滚', () => {
  it('H4 修复后：BUNDLE_MISCLASSIFY 有快照时经快照回滚恢复原 bundles', async () => {
    const profile = tempDir('r4-bundle-');
    fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ name: 'x', dsh: { profile: { bundles: ['keep', 'drop'] } } }));
    const snap = createSnapshot(fsPort, profile).snapshot;
    fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ name: 'x', dsh: { profile: { bundles: [] } } }));
    const r = await rollbackAction(makeCore(), { code: 'BUNDLE_MISCLASSIFY', rollback: '恢复原 bundles 列表', rollbackType: 'snapshot' }, { state: { rollback: { snapshot: snap } }, profile });
    expect(r.ok).toBe(true);
    const m = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'));
    expect(m.dsh.profile.bundles).toEqual(['keep', 'drop']);
    fs.rmSync(profile, { recursive: true, force: true });
  });

  it('证实：非 BUNDLE 动作有快照时确实回滚（对照组，钉死 restoreSnapshot 语义）', async () => {
    const profile = tempDir('r4-bundle-ok-');
    fs.writeFileSync(path.join(profile, 'a.txt'), 'orig');
    const snap = createSnapshot(fsPort, profile).snapshot;
    fs.writeFileSync(path.join(profile, 'a.txt'), 'MUT');
    const r = await rollbackAction(makeCore(), { code: 'LINK_FAIL', rollback: '移除坏链接', rollbackType: 'snapshot' }, { state: { rollback: { snapshot: snap } }, profile });
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(profile, 'a.txt'), 'utf8')).toBe('orig');
    fs.rmSync(profile, { recursive: true, force: true });
  });
});
