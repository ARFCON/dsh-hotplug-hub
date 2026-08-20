'use strict';
// test/qa4-stages-extra.test.js — QA4：阶段细节补测
// stageLogs tail 边界 / stageStatus DEGRADED / stageRollback 快照缺失与成功写入 /
// stageInstall resolved 异常态 / stageHeal 陈旧日志过滤（C3 since 语义）/ stageCheck 阻断冲突。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../app/create-core');
const { STAGES } = require('../app/stages');
const { createRunLog } = require('../infra/runlog');
const { tempDir, isolatedEnv } = require('./helpers');

const ROOT = path.join(__dirname, '..');

function emptyState(id) {
  return {
    schemaVersion: 1, id, assemblySha256: null, phase: 'IDLE',
    resolved: { plugins: [], conflicts: [], pinnedAt: null },
    install: { status: 'missing', lastExit: null, nodeModules: false },
    launch: { lastExit: null, lastStart: null, retries: 0, pid: null },
    heal: { history: [], quarantined: [] },
    rollback: { snapshot: null, lastRollbackAt: null }
  };
}

function makeCore(home, overrides = {}) {
  return createCore({
    baseDir: ROOT,
    home,
    platform: 'win32',
    env: isolatedEnv(home),
    nowPort: overrides.nowPort,
    // 独立 roots：每个测试用例隔离根目录（防止 sandboxRoot 复用导致日志/产物串扰）
    roots: {
      assemblyDir: path.join(home, 'assembly'),
      sandboxRoot: path.join(home, 'sandbox'),
      profilesRoot: path.join(home, '.dsh', 'profiles'),
      storeRoot: path.join(home, '.dsh', 'hotplug-store')
    }
  });
}

describe('QA4 stageLogs（tail 边界）', () => {
  function setupLogs(home, id, n) {
    const core = makeCore(home);
    const sb = path.join(core.config.roots.sandboxRoot, id);
    fs.mkdirSync(path.join(sb, 'logs'), { recursive: true });
    const log = createRunLog(core.ports.fs, path.join(sb, 'logs', 'run.jsonl'), { now: Date.now });
    for (let i = 0; i < n; i += 1) log.append({ stream: 'stdout', line: `line-${i}` });
    return core;
  }

  it('tail=0 返回全部（logs 语义：0=全部）', async () => {
    const home = tempDir('qa4l1-');
    const core = setupLogs(home, 'demo', 5);
    const state = emptyState('demo');
    const r = await STAGES.logs(core, state, { id: 'demo', tail: 0 });
    expect(r.ok).toBe(true);
    expect(r.data.count).toBe(5);
    expect(r.data.entries).toHaveLength(5);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('tail=N 只取最后 N 条且顺序保持', async () => {
    const home = tempDir('qa4l2-');
    const core = setupLogs(home, 'demo', 5);
    const r = await STAGES.logs(core, emptyState('demo'), { id: 'demo', tail: 2 });
    expect(r.ok).toBe(true);
    expect(r.data.entries).toHaveLength(2);
    expect(r.data.entries[0].line).toBe('line-3');
    expect(r.data.entries[1].line).toBe('line-4');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('tail 超过条目总数 → 返回全部', async () => {
    const home = tempDir('qa4l3-');
    const core = setupLogs(home, 'demo', 3);
    const r = await STAGES.logs(core, emptyState('demo'), { id: 'demo', tail: 99 });
    expect(r.ok).toBe(true);
    expect(r.data.entries).toHaveLength(3);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('无日志文件 → count=0 空列表（不报错）', async () => {
    const home = tempDir('qa4l4-');
    const core = makeCore(home);
    const r = await STAGES.logs(core, emptyState('demo'), { id: 'demo', tail: 10 });
    expect(r.ok).toBe(true);
    expect(r.data.count).toBe(0);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('QA4 stageStatus（降级诚实报告）', () => {
  it('assembly 缺失 → STATUS DEGRADED 且字段如实', async () => {
    const home = tempDir('qa4t1-');
    const core = makeCore(home);
    const r = await STAGES.status(core, emptyState('demo'), { id: 'demo' });
    expect(r.ok).toBe(true); // status 永远 ok（报告健康度而非命令成败）
    expect(r.data.healthy).toBe(false);
    expect(r.data.assemblyExists).toBe(false);
    expect(r.data.sandboxExists).toBe(false);
    expect(r.data.profileOk).toBe(false);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('QA4 stageRollback（快照语义）', () => {
  it('无快照 → ERR_HEAL_ROLLBACK（exit=9 域）', async () => {
    const home = tempDir('qa4r1-');
    const core = makeCore(home);
    const state = emptyState('demo');
    state.phase = 'LAUNCHED';
    const r = await STAGES.rollback(core, state, { id: 'demo' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ERR_HEAL_ROLLBACK');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('有快照 → 恢复成功、phase=ROLLED_BACK、lastRollbackAt 写入', async () => {
    const home = tempDir('qa4r2-');
    const core = makeCore(home, { nowPort: { iso: () => '2026-08-21T08:00:00.000Z' } });
    const profileDir = path.join(home, '.dsh', 'profiles', 'demo');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'package.json'), '{"v":1}');
    const snap = core.infra.snapshot.createSnapshot(core.ports.fs, profileDir, { createdAt: '2026-08-21T07:00:00.000Z' });
    expect(snap.ok).toBe(true);
    // 修改后回滚
    fs.writeFileSync(path.join(profileDir, 'package.json'), '{"v":2}');
    const state = emptyState('demo');
    state.phase = 'LAUNCHED';
    state.rollback.snapshot = snap.snapshot;
    state.rollback.lastRollbackAt = null;
    const r = await STAGES.rollback(core, state, { id: 'demo' });
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8')).toBe('{"v":1}');
    expect(state.phase).toBe('ROLLED_BACK');
    expect(state.rollback.lastRollbackAt).toBe('2026-08-21T08:00:00.000Z');
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('QA4 stageInstall（resolved 异常态）', () => {
  it('phase=CHECKED 但 resolved 缺失 → ERR_INSTALL_DEP（不崩溃）', async () => {
    const home = tempDir('qa4n1-');
    const core = makeCore(home);
    const state = emptyState('demo');
    state.phase = 'CHECKED';
    state.resolved = null; // 异常态：状态机放行但数据缺失
    const r = await STAGES.install(core, state, { id: 'demo' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ERR_INSTALL_DEP');
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('QA4 stageHeal（C3 陈旧日志过滤）', () => {
  it('仅分类 lastStart 之后的日志：陈旧故障行不触发动作', async () => {
    const home = tempDir('qa4h1-');
    const core = makeCore(home, { nowPort: { iso: () => '2026-08-21T09:00:00.000Z', now: () => Date.now() } });
    const sb = path.join(core.config.roots.sandboxRoot, 'demo');
    fs.mkdirSync(path.join(sb, 'logs'), { recursive: true });
    const log = createRunLog(core.ports.fs, path.join(sb, 'logs', 'run.jsonl'), {
      now: () => Date.parse('2026-08-20T00:00:00.000Z') // 陈旧时间
    });
    log.append({ stream: 'stderr', line: 'Error: ENOENT: no such file' }); // 陈旧故障行
    const state = emptyState('demo');
    state.phase = 'LAUNCHED';
    state.launch.lastStart = '2026-08-21T08:00:00.000Z'; // 启动发生在故障之后
    const r = await STAGES.heal(core, state, { id: 'demo', yes: false });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ERR_HEAL_NO_ACTION');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('lastStart 之后的故障日志正常触发预览动作', async () => {
    const home = tempDir('qa4h2-');
    const core = makeCore(home, { nowPort: { iso: () => '2026-08-21T09:00:00.000Z', now: () => Date.now() } });
    const sb = path.join(core.config.roots.sandboxRoot, 'demo');
    fs.mkdirSync(path.join(sb, 'logs'), { recursive: true });
    const log = createRunLog(core.ports.fs, path.join(sb, 'logs', 'run.jsonl'), {
      now: () => Date.parse('2026-08-21T08:30:00.000Z') // lastStart 之后
    });
    log.append({ stream: 'stderr', line: 'Error: ENOENT: no such file' });
    const state = emptyState('demo');
    state.phase = 'LAUNCHED';
    state.launch.lastStart = '2026-08-21T08:00:00.000Z';
    const r = await STAGES.heal(core, state, { id: 'demo', yes: false });
    expect(r.ok).toBe(true); // 预览 OK
    expect(r.data.actions).toContain('LINK_FAIL');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('lastStart 非法（NaN）→ 不按时间过滤（回退全部日志）', async () => {
    const home = tempDir('qa4h3-');
    const core = makeCore(home, { nowPort: { iso: () => '2026-08-21T09:00:00.000Z', now: () => Date.now() } });
    const sb = path.join(core.config.roots.sandboxRoot, 'demo');
    fs.mkdirSync(path.join(sb, 'logs'), { recursive: true });
    const log = createRunLog(core.ports.fs, path.join(sb, 'logs', 'run.jsonl'), { now: () => Date.now() });
    log.append({ stream: 'stderr', line: 'Error: EACCES: permission denied' });
    const state = emptyState('demo');
    state.phase = 'LAUNCHED';
    state.launch.lastStart = 'not-a-date'; // 非法时间
    const r = await STAGES.heal(core, state, { id: 'demo', yes: false });
    expect(r.ok).toBe(true);
    expect(r.data.actions).toContain('INSTALL_FAIL');
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('QA4 stageCheck / stageAssemble（阻断与缺失）', () => {
  it('check 命中 error 级冲突（依赖图）→ ERR_CONFLICT_*（exit=4 域）', async () => {
    const home = tempDir('qa4c1-');
    const core = makeCore(home);
    const dir = path.join(core.config.roots.assemblyDir, 'demo');
    fs.mkdirSync(dir, { recursive: true });
    // 重复 name 会被 assembly 层拦截（ERR_ASSEMBLY_DUPLICATE），版本冲突的真实可达
    // 形态是依赖图冲突：pkg-b 声明依赖 pkg-a@^2.0.0，实际 pkg-a@1.0.0 → error 级
    fs.writeFileSync(path.join(dir, 'assembly.json'), JSON.stringify({
      hotpack: '1.0', id: 'demo', name: 'd', version: '1.0.0',
      plugins: [
        { id: 'a', name: 'pkg-a', version: '1.0.0', source: { type: 'npm' }, config: {} },
        { id: 'b', name: 'pkg-b', version: '1.0.0', source: { type: 'npm' }, config: { dependencies: { 'pkg-a': '^2.0.0' } } }
      ]
    }));
    const r = await STAGES.check(core, emptyState('demo'), { id: 'demo' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ERR_CONFLICT_DEPENDENCY');
    expect(r.exitCode).toBe(4);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('assemble 找不到 assembly 文件 → ERR_ASSEMBLY_NOT_FOUND（exit=3 域）', async () => {
    const home = tempDir('qa4c2-');
    const core = makeCore(home);
    const r = await STAGES.assemble(core, emptyState('demo'), { id: 'demo' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ERR_ASSEMBLY_NOT_FOUND');
    expect(r.exitCode).toBe(3);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('assemble 读取失败（权限）→ ERR_ASSEMBLY_NOT_FOUND 语义码而非 FATAL', async () => {
    const home = tempDir('qa4c3-');
    const core = makeCore(home);
    const dir = path.join(core.config.roots.assemblyDir, 'demo');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'assembly.json'), '{}');
    // 注入 readFileSync 抛错
    const fsPort = core.ports.fs;
    const orig = fsPort.readFileSync;
    fsPort.readFileSync = (f, enc) => { if (String(f).includes('assembly.json')) throw new Error('EACCES'); return orig(f, enc); };
    const r = await STAGES.assemble(core, emptyState('demo'), { id: 'demo' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ERR_ASSEMBLY_NOT_FOUND');
    fs.rmSync(home, { recursive: true, force: true });
  });
});
