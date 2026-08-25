'use strict';
// test/self-heal-audit.test.js — 「自检自愈」全面审计回归（契约统一 / 信号可达性 / 极端情况）
// 本文件钉死 7 个真实缺陷，每个缺陷均由"先失败后修复"的测试覆盖：
//   A1 监控写入的 UTF-8 损坏信号（[UTF8_CORRUPTION] 标记）→ 分类为 UTF8_CORRUPTION
//   A2 stderr 输出含 U+FFFD → 分类为 UTF8_CORRUPTION（日志出现 U+FFFD 触发）
//   B  REGISTRY_UNAVAILABLE 用 reprobe-registry（非 github 镜像克隆）
//   C  GITHUB_ACQUIRE_FAIL 镜像重试克隆所有未落地 github 插件（非仅首个）
//   D  rollbackAction 按 action.code 判定跳过（非 rollback 文案魔法字符串）
//   E  verify 失败且回滚失败 → 立即 ERR_HEAL_BUDGET（不静默重试）
//   F  VERSION_CONFLICT pin-compatible 成功后不误隔离健康插件
//   G  launch spawn 失败持久化 spawnCode → classifyStateSignals 产出 HARNESS_FIX
const fs = require('fs');
const os = require('os');
const path = require('path');
const { classifySignal, classifyEntries, classifyStateSignals } = require('../domain/classify');
const { describeAction, planActions } = require('../domain/healplan');
const { executeAction } = require('../infra/heal-steps');
const { verifyAction, rollbackAction } = require('../infra/heal-verify');
const { runHeal } = require('../infra/heal');
const { buildHealContext } = require('../app/stages-heal');
const { createFsPort } = require('../ports/fs');
const { createSnapshot } = require('../infra/snapshot');
const { tempDir } = require('./helpers');

const fsPort = createFsPort(fs);

function makeCore(overrides = {}) {
  return {
    ports: { fs: fsPort, registry: null, now: { now: () => 1000, iso: () => '2026-08-20T00:00:00.000Z' } },
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

describe('自愈审计 A：UTF8_CORRUPTION 信号可达性', () => {
  it('监控写入的损坏信号（[UTF8_CORRUPTION] 标记）→ classifyEntries 产出 UTF8_CORRUPTION', () => {
    const entries = [
      { seq: 1, stream: 'error', line: '[UTF8_CORRUPTION] 检测到 UTF-8 损坏（流结束时残缺多字节序列）' }
    ];
    const actions = classifyEntries(entries).map((x) => x.action);
    expect(actions).toContain('UTF8_CORRUPTION');
  });

  it('stderr 输出含 U+FFFD → UTF8_CORRUPTION（日志出现 U+FFFD 触发）', () => {
    const c = classifySignal({ kind: 'stderr', line: 'Error: 配置损坏 \uFFFD data' });
    expect(c).not.toBeNull();
    expect(c.action).toBe('UTF8_CORRUPTION');
  });

  it('error 级 log 含 U+FFFD → UTF8_CORRUPTION（既有语义保留）', () => {
    expect(classifySignal({ kind: 'log', severity: 'error', message: '损坏 \uFFFD' }).action).toBe('UTF8_CORRUPTION');
  });

  it('正常日志含 UTF8_CORRUPTION 字样但不含标记/替换符 → 不误报', () => {
    // 用户日志里普通提及 "UTF8_CORRUPTION" 词（无 [..] 标记、无 U+FFFD）不误报
    expect(classifySignal({ kind: 'stderr', line: 'my app says UTF8_CORRUPTION is handled' })).toBeNull();
  });
});

describe('自愈审计 B：REGISTRY_UNAVAILABLE 语义', () => {
  it('动作步骤为 reprobe-registry（非 github 镜像克隆）', () => {
    const a = describeAction('REGISTRY_UNAVAILABLE');
    expect(a.steps.map((s) => s.type)).toEqual(['reprobe-registry']);
  });

  it('reprobe-registry：registry 抛错 → ERR_INSTALL_ACQUIRE；恢复 → ok', async () => {
    const bad = await executeAction(
      makeCore({ ports: { fs: fsPort, registry: { availableVersions: () => { throw new Error('ECONNREFUSED'); } } } }),
      { code: 'REGISTRY_UNAVAILABLE', steps: [{ type: 'reprobe-registry' }] }, {}
    );
    expect(bad.ok).toBe(false);
    expect(bad.error.code).toBe('ERR_INSTALL_ACQUIRE');

    const ok = await executeAction(
      makeCore({ ports: { fs: fsPort, registry: { availableVersions: () => ['1.0.0'] } } }),
      { code: 'REGISTRY_UNAVAILABLE', steps: [{ type: 'reprobe-registry' }] }, {}
    );
    expect(ok.ok).toBe(true);
  });

  it('无 registry 端口（空实现）→ 视为可用（与 verifyAction 语义一致）', async () => {
    const r = await executeAction(makeCore(), { code: 'REGISTRY_UNAVAILABLE', steps: [{ type: 'reprobe-registry' }] }, {});
    expect(r.ok).toBe(true);
  });
});

describe('自愈审计 C：GITHUB_ACQUIRE_FAIL 多插件镜像重试', () => {
  it('onMirror 克隆所有未落地的 github 插件（非仅首个）', async () => {
    const gh1 = { name: 'g1', source: { type: 'github', ref: 'main' } };
    const gh2 = { name: 'g2', source: { type: 'github', ref: 'main' } };
    const state = { heal: {}, resolved: { plugins: [gh1, gh2] } };
    const calls = [];
    const install = { installGithubPluginWithMirror: vi.fn(async (_c, p) => { calls.push(p.name); return { ok: true }; }) };
    const core = { infra: { install }, ports: { fs: fsPort } };
    const c = buildHealContext(core, state, 'demo', '/nonexistent-profile');
    const r = await c.onMirror('https://m');
    expect(r.ok).toBe(true);
    expect(calls).toEqual(['g1', 'g2']);
  });

  it('onMirror：无 github 插件 → ERR_INSTALL_ACQUIRE（既有语义保留）', async () => {
    const state = { heal: {}, resolved: { plugins: [{ name: 'a', source: { type: 'npm' } }] } };
    const c = buildHealContext({}, state, 'demo', '/p');
    const r = await c.onMirror('https://m');
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_INSTALL_ACQUIRE');
  });
});

describe('自愈审计 D：rollbackAction 判定键', () => {
  it('非 BUNDLE 动作即使 rollback 文案与 BUNDLE_MISCLASSIFY 相同也不跳过快照回滚', async () => {
    const profile = tempDir('audit-d-');
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(path.join(profile, 'a.txt'), 'orig');
    const snap = createSnapshot(fsPort, profile).snapshot;
    fs.writeFileSync(path.join(profile, 'a.txt'), 'MUT');
    const r = await rollbackAction(makeCore(), { code: 'SOME_OTHER_ACTION', rollback: '恢复原 bundles 列表', rollbackType: 'snapshot' }, { state: { rollback: { snapshot: snap } }, profile });
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(profile, 'a.txt'), 'utf8')).toBe('orig'); // 回滚确实发生
    fs.rmSync(profile, { recursive: true, force: true });
  });
});

describe('自愈审计 E：verify 失败路径回滚失败终止', () => {
  it('verify 失败且回滚失败 → 立即 ERR_HEAL_BUDGET（history 仅 1 次，不静默重试）', async () => {
    const core = makeCore();
    const profile = tempDir('audit-e-');
    const action = { code: 'CRASH_LOOP', steps: [], budget: 3, rollback: '恢复被禁用插件', rollbackType: 'snapshot' };
    // 回滚必失败：快照含 external 文件但 externalDir 缺失
    const snapshot = { dir: profile, createdAt: 'x', externalDir: null, files: [{ rel: 'x.bin', hash: 'x', external: true, type: 'file' }] };
    const ctx = { state: { launch: { lastExit: 5, retries: 1 }, rollback: { snapshot } }, profile, plugins: [] };
    const r = await runHeal(core, [action], ctx, { dryRun: false });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_HEAL_BUDGET');
    expect(r.result.history.length).toBe(1); // 回滚失败 → 终止，不重试
    fs.rmSync(profile, { recursive: true, force: true });
  });
});

describe('自愈审计 F：VERSION_CONFLICT 不误隔离', () => {
  it('pin-compatible 成功后不调用 quarantine（不隔离健康插件）', async () => {
    const quarantine = vi.fn(() => ({ ok: true }));
    const registry = { availableVersions: (name) => ({ a: ['1.0.0'], b: ['2.0.0'] }[name] || []) };
    const plugins = [npmPlugin('a', '^1.0.0'), npmPlugin('b', '^2.0.0')];
    const action = describeAction('VERSION_CONFLICT');
    const r = await executeAction(makeCore({ ports: { fs: fsPort, registry } }), action, { plugins, state: { id: 'x' }, quarantine });
    expect(r.ok).toBe(true);
    expect(quarantine).not.toHaveBeenCalled();
  });

  it('pin-compatible 仍冲突 → ERR_CONFLICT_BLOCKED（诚实失败，不误隔离）', async () => {
    const registry = { availableVersions: () => ['1.0.0', '2.0.0'] };
    const plugins = [npmPlugin('dup', '^1.0.0'), { ...npmPlugin('dup', '^2.0.0'), id: 'p-dup-2' }];
    const action = describeAction('VERSION_CONFLICT');
    const r = await executeAction(makeCore({ ports: { fs: fsPort, registry } }), action, { plugins, state: { id: 'x' }, quarantine: () => ({ ok: true }) });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_CONFLICT_BLOCKED');
  });
});

describe('自愈审计 G：HARNESS_FIX 信号可达', () => {
  it('launch.spawnCode=ENOENT → HARNESS_FIX；EACCES → INSTALL_FAIL；与 CRASH_LOOP 互斥', () => {
    expect(classifyStateSignals({ launch: { spawnCode: 'ENOENT', lastExit: null, retries: 5 } }).map((x) => x.action)).toEqual(['HARNESS_FIX']);
    expect(classifyStateSignals({ launch: { spawnCode: 'EACCES', lastExit: null, retries: 5 } }).map((x) => x.action)).toEqual(['INSTALL_FAIL']);
    expect(classifyStateSignals({ launch: { spawnCode: 'UNKNOWN', lastExit: null, retries: 5 } }).map((x) => x.action)).toEqual(['HARNESS_FIX']);
  });

  it('无 spawnCode 时维持原 CRASH_LOOP 语义', () => {
    expect(classifyStateSignals({ launch: { lastExit: 1, retries: 3 } }).map((x) => x.action)).toEqual(['CRASH_LOOP']);
    expect(classifyStateSignals({ launch: { lastExit: null, retries: 0 } })).toEqual([]);
  });

  it('spawn-error 信号经 planActions 生成 HARNESS_FIX 动作', () => {
    const cls = classifySignal({ kind: 'spawn-error', err: { code: 'ENOENT' } });
    const planned = planActions(cls, { dryRun: true });
    expect(planned.actions.map((a) => a.code)).toEqual(['HARNESS_FIX']);
  });
});

describe('自愈审计 G2：stageLaunch 持久化 spawnCode（HARNESS_FIX 端到端可达）', () => {
  it('spawn 异步 ENOENT → state.launch.spawnCode=ENOENT（供 heal 分类）', async () => {
    const { createCore } = require('../app/create-core');
    const { createProcPort } = require('../ports/proc');
    const { STAGES } = require('../app/stages');
    const { EventEmitter } = require('events');
    const { PassThrough } = require('stream');
    const ROOT = path.join(__dirname, '..');
    const home = tempDir('audit-g2-');
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    env.HOME = home; env.USERPROFILE = home;
    env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
    env.ProgramFiles = path.join(home, 'pf');
    env['ProgramFiles(x86)'] = path.join(home, 'pf86');
    env.PATH = path.join(home, 'bin');
    env.DSH_HOME = path.join(home, '.dsh');
    // 假 harness：findHarness 通过候选路径命中
    const hpath = path.join(home, 'AppData', 'Local', 'Programs', 'DSH Desktop', 'DSH Desktop.exe');
    fs.mkdirSync(path.dirname(hpath), { recursive: true });
    fs.writeFileSync(hpath, 'MZ fake harness');
    const core = createCore({
      baseDir: ROOT, home, platform: 'win32', env,
      procPort: createProcPort({ spawn: () => { throw new Error('n/a'); }, spawnSync: () => ({ status: 1, error: null, stderr: '', stdout: '' }) })
    });
    const id = 'auditg2';
    const sb = path.join(ROOT, 'sandbox', '.sandbox', id);
    fs.mkdirSync(path.join(sb, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(sb, 'package.json'), JSON.stringify({ name: 'x', version: '0.1.0', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }));
    fs.writeFileSync(path.join(sb, 'cordis.patch.yml'), '- insert: []\n');
    const state = {
      schemaVersion: 1, id, assemblySha256: null, phase: 'INSTALLED',
      resolved: { plugins: [], conflicts: [], pinnedAt: null },
      install: { status: 'ok', lastExit: 0, nodeModules: false },
      launch: { lastExit: null, lastStart: null, retries: 0, pid: null },
      heal: { history: [], quarantined: [] },
      rollback: { snapshot: null, lastRollbackAt: null }
    };
    let childRef;
    core.ports.proc.spawn = () => {
      childRef = new EventEmitter();
      childRef.stdout = new PassThrough();
      childRef.stderr = new PassThrough();
      childRef.unref = () => {};
      childRef.kill = () => true;
      return childRef;
    };
    const p = STAGES.launch(core, state, { id, wait: true });
    // 让 error 事件在 spawn 返回后异步派发（模拟真实 spawn 异步失败）
    setTimeout(() => childRef.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })), 10);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ERR_LAUNCH_SPAWN');
    expect(state.launch.spawnCode).toBe('ENOENT');
    expect(state.launch.lastExit).toBeNull();
    // H3b 回归：失败 launch（spawn 失败）也锚定 lastStart，heal 才能分类本次崩溃 stderr
    expect(state.launch.lastStart).not.toBeNull();
    fs.rmSync(sb, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
});
