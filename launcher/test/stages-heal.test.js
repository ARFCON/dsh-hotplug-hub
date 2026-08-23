'use strict';
// test/stages-heal.test.js — app/stages-heal.js 全覆盖（heal 阶段 + 自愈上下文）
// 覆盖：无信号 ERR_HEAL_NO_ACTION（FIX-7）、dryRun 预览零副作用（C7）、
// --yes 成功 → HEALING + history、--yes 失败 → QUARANTINED + history（C7）、
// buildHealContext quarantine（显式目标/缺省取末位/无插件）、onMirror（有/无 github 源）。
const path = require('path');
const os = require('os');
const fs = require('fs');
const { createCore } = require('../app/create-core');
const { createProcPort } = require('../ports/proc');
const { stageHeal, buildHealContext } = require('../app/stages-heal');
const { createSnapshot } = require('../infra/snapshot');
const { createFsPort } = require('../ports/fs');
const { isolatedEnv, tempDir } = require('./helpers');

const fsPort = createFsPort(fs);

function healStageCore() {
  const home = tempDir('stages-heal-home-');
  return createCore({
    baseDir: path.join(__dirname, '..'),
    home,
    env: isolatedEnv(home),
    procPort: createProcPort({
      spawn: () => { throw new Error('stageHeal 不应 spawn'); },
      spawnSync: () => ({ status: 1, error: null, stderr: '', stdout: '' })
    })
  });
}

function crashState(extra = {}) {
  return {
    id: 'demo',
    phase: 'LAUNCHED',
    launch: { lastExit: 1, retries: 5, lastStart: new Date().toISOString() },
    resolved: {
      plugins: [
        { id: 'p-a', name: 'pkg-a', version: '1.0.0', source: { type: 'npm' }, resolvedVersion: '1.0.0', config: {} }
      ]
    },
    heal: {},
    ...extra
  };
}

describe('app/stages-heal.js stageHeal', () => {
  it('无自愈信号 → ERR_HEAL_NO_ACTION（FIX-7，exit 9，不静默 HEAL OK）', async () => {
    const core = healStageCore();
    // phase 取 LAUNCHED（IDLE 不可 heal，M-24），launch 无退出信号
    const r = await stageHeal(core, { id: 'demo', phase: 'LAUNCHED', launch: {}, heal: {} }, { id: 'demo', yes: true });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ERR_HEAL_NO_ACTION');
    expect(r.exitCode).toBe(9);
  });

  it('有信号 + 预览（无 --yes）→ 预览 ok，state 零副作用（C7）', async () => {
    const core = healStageCore();
    const state = crashState();
    const before = JSON.stringify(state);
    const r = await stageHeal(core, state, { id: 'demo', yes: false });
    expect(r.ok).toBe(true);
    expect(r.message).toContain('预览');
    expect(r.data.actions).toContain('CRASH_LOOP');
    // 预览零持久副作用：phase/history/dirty 均未变
    expect(JSON.stringify(state)).toBe(before);
    expect(state.phase).toBe('LAUNCHED');
    // 审计修复回归：预览（无 --yes）不得创建 profile 目录（mkdirSync 副作用守卫）。
    // 此前无条件 mkdirSync 违反"预览零持久副作用"契约——现用磁盘断言钉死。
    const profileDir = path.join(core.config.roots.profilesRoot, 'demo');
    expect(fs.existsSync(profileDir)).toBe(false);
  });

  it('有信号 + --yes + 快照 → ok，phase=HEALING，history 追加（C7）', async () => {
    const core = healStageCore();
    const state = crashState();
    // 预建 profile 目录并打真实快照（rollback-snapshot 步骤需要）
    const profileDir = path.join(core.config.roots.profilesRoot, 'demo');
    fs.mkdirSync(path.join(profileDir, 'node_modules', 'pkg-a'), { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'node_modules', 'pkg-a', 'package.json'), '{"name":"pkg-a"}');
    const snap = createSnapshot(fsPort, profileDir);
    expect(snap.ok).toBe(true);
    state.rollback = { snapshot: snap.snapshot };
    const r = await stageHeal(core, state, { id: 'demo', yes: true });
    expect(r.ok).toBe(true);
    expect(r.message).toContain('HEAL OK');
    expect(state.phase).toBe('HEALING');
    expect(state.dirty).toBe(true);
    expect(state.heal.history.length).toBeGreaterThan(0);
    expect(state.heal.history[0].verified).toBe(true);
    // 崩溃计数闭环：launch.lastExit 被重置为 null
    expect(state.launch.lastExit).toBeNull();
    expect(state.launch.retries).toBe(0);
    // disable-recent 隔离了最近插件（quarantine 落 state.heal.quarantined）
    expect(state.heal.quarantined).toContain('pkg-a');
  });

  it('有信号 + --yes + 无快照 → 动作失败 → phase=QUARANTINED + history（C7 失败持久化）', async () => {
    const core = healStageCore();
    const state = crashState(); // 无 rollback.snapshot
    const r = await stageHeal(core, state, { id: 'demo', yes: true });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ERR_HEAL_BUDGET');
    expect(state.phase).toBe('QUARANTINED');
    expect(state.dirty).toBe(true);
    expect(state.heal.history.length).toBeGreaterThan(0);
    expect(state.heal.history[0].verified).toBe(false);
  });

  it('preview（无 --yes）失败路径不持久化 QUARANTINED（C7 预览零副作用）', async () => {
    const core = healStageCore();
    const state = crashState(); // 无快照 → 动作会失败
    const r = await stageHeal(core, state, { id: 'demo', yes: false });
    // 预览模式 runHeal 不执行动作（dryRun），故预览成功
    expect(r.ok).toBe(true);
    expect(state.phase).toBe('LAUNCHED');
    expect(state.dirty).toBeUndefined();
  });

  it('phase 非法 → ERR_ARG_BAD_STATE（M-36：不可 heal 的状态）', async () => {
    const core = healStageCore();
    const r = await stageHeal(core, { id: 'demo', phase: 'ASSEMBLED', launch: {}, heal: {} }, { id: 'demo', yes: true });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ERR_ARG_BAD_STATE');
    expect(r.exitCode).toBe(2);
  });
});

describe('app/stages-heal.js buildHealContext', () => {
  function ctx(plugins, state) {
    return buildHealContext({}, state, 'demo', '/fake/profile');
  }

  it('plugins 过滤已隔离插件（quarantine 消费一致性，C6）', () => {
    const state = { heal: { quarantined: ['pkg-b'] }, resolved: { plugins: [
      { name: 'pkg-a' }, { name: 'pkg-b' }
    ] } };
    const c = ctx(null, state);
    expect(c.plugins.map((p) => p.name)).toEqual(['pkg-a']);
    expect(c.pack.plugins.map((p) => p.name)).toEqual(['pkg-a']);
  });

  it('quarantine：显式目标 → 加入 quarantined + dirty', () => {
    const state = { heal: {}, dirty: false, resolved: { plugins: [{ name: 'a' }, { name: 'b' }] } };
    const c = buildHealContext({}, state, 'demo', '/p');
    const r = c.quarantine('b');
    expect(r).toEqual({ ok: true });
    expect(state.heal.quarantined).toEqual(['b']);
    expect(state.dirty).toBe(true);
  });

  it('quarantine：缺省目标取末位插件（disable-recent 语义）', () => {
    const state = { heal: {}, resolved: { plugins: [{ name: 'a' }, { name: 'b' }] } };
    const c = buildHealContext({}, state, 'demo', '/p');
    c.quarantine();
    expect(state.heal.quarantined).toEqual(['b']);
  });

  it('quarantine：无插件可隔离 → ERR_HEAL_BUDGET', () => {
    const state = { heal: {}, resolved: { plugins: [] } };
    const c = buildHealContext({}, state, 'demo', '/p');
    const r = c.quarantine();
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_HEAL_BUDGET');
    expect(r.error.message).toContain('无插件可隔离');
  });

  it('onMirror：无 github 源插件 → ERR_INSTALL_ACQUIRE（不静默 ok）', async () => {
    const state = { heal: {}, resolved: { plugins: [{ name: 'a', source: { type: 'npm' } }] } };
    const c = buildHealContext({}, state, 'demo', '/p');
    const r = await c.onMirror('https://m');
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_INSTALL_ACQUIRE');
  });

  it('onMirror：有 github 源插件 → 调用 installGithubPluginWithMirror', async () => {
    const gh = { name: 'g', source: { type: 'github', ref: 'main' } };
    const state = { heal: {}, resolved: { plugins: [gh, { name: 'a', source: { type: 'npm' } }] } };
    const install = { installGithubPluginWithMirror: vi.fn(async () => ({ ok: true, channel: 'github', mirror: 'https://m' })) };
    const core = { infra: { install } };
    const c = buildHealContext(core, state, 'demo', '/p');
    const r = await c.onMirror('https://m');
    expect(r.ok).toBe(true);
    expect(install.installGithubPluginWithMirror).toHaveBeenCalledWith(core, gh, '/p', 'https://m');
  });
});
