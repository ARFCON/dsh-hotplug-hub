'use strict';
// test/audit-check-status-r4b.test.js — 自检（check/status/logs 只读诊断）深度审计（R4，B 部分）
// 承接 audit-check-status-r4.test.js（A 部分），共享 helper 见 audit-check-status-common.js。
const fs = require('fs');
const path = require('path');
const { STAGES } = require('../app/stages');
const { runPipeline } = require('../app/pipeline');
const { assertCommandPipeline, STATES, COMMAND_PIPELINES } = require('../contracts/state-machine');
const { checkConflicts } = require('../domain/conflicts');
const { resolvePlugins } = require('../domain/resolve');
const { tempDir } = require('./helpers');
const {
  emptyState, makeCore, writeCleanAssembly, writeConflictAssembly, writeWarningOnlyAssembly,
  setupStatusFiles, writeLogFile
} = require('./audit-check-status-common');

// =====================================================================
// 疑点 5：stageLogs 的 tail 语义
// =====================================================================
describe('R4-5 stageLogs tail 语义', () => {
  it('[记录] tail=0 → 返回全部（logs 语义：0=全部，与 parser 一致）', async () => {
    const home = tempDir('r4l1-');
    const core = makeCore(home);
    writeLogFile(core, 'demo', ['a', 'b', 'c', 'd', 'e'], []);
    const r = await STAGES.logs(core, emptyState('demo'), { id: 'demo', tail: 0 });
    expect(r.ok).toBe(true);
    expect(r.data.count).toBe(5);
    expect(r.data.entries).toHaveLength(5);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('[记录] count 是切片前总数，entries 是切片后（tail<N 时 count ≠ entries.length）', async () => {
    const home = tempDir('r4l2-');
    const core = makeCore(home);
    writeLogFile(core, 'demo', ['a', 'b', 'c', 'd', 'e'], []);
    const r = await STAGES.logs(core, emptyState('demo'), { id: 'demo', tail: 2 });
    expect(r.data.count).toBe(5); // 总数
    expect(r.data.entries.map((e) => e.line)).toEqual(['d', 'e']); // 切片后最后 2 条
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('[记录] 负数 tail（直接调用 stageLogs）→ 返回全部（parser 会把负数回退 50，二者不一致）', async () => {
    const home = tempDir('r4l3-');
    const core = makeCore(home);
    writeLogFile(core, 'demo', ['a', 'b', 'c'], []);
    const r = await STAGES.logs(core, emptyState('demo'), { id: 'demo', tail: -5 });
    expect(r.data.entries).toHaveLength(3);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('[记录] 非整数 tail（2.5）→ slice 向零截断为最后 2 条（parser 不校验整数，属输入校验缺口）', async () => {
    const home = tempDir('r4l4-');
    const core = makeCore(home);
    writeLogFile(core, 'demo', ['a', 'b', 'c', 'd', 'e'], []);
    const r = await STAGES.logs(core, emptyState('demo'), { id: 'demo', tail: 2.5 });
    expect(r.data.entries).toHaveLength(2); // slice(-2.5) → -2
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('[锚点] tail 超过条目总数 → 返回全部（不越界）', async () => {
    const home = tempDir('r4l5-');
    const core = makeCore(home);
    writeLogFile(core, 'demo', ['a', 'b', 'c'], []);
    const r = await STAGES.logs(core, emptyState('demo'), { id: 'demo', tail: 99 });
    expect(r.data.entries).toHaveLength(3);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('[锚点] includeRotated 合并顺序：先 .1（旧）后主文件（新），tail 取最近条目', async () => {
    const home = tempDir('r4l6-');
    const core = makeCore(home);
    writeLogFile(core, 'demo', ['main-3', 'main-4'], ['rot-1', 'rot-2']);
    const r = await STAGES.logs(core, emptyState('demo'), { id: 'demo', tail: 10 });
    expect(r.data.count).toBe(4);
    expect(r.data.entries.map((e) => e.line)).toEqual(['rot-1', 'rot-2', 'main-3', 'main-4']);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('[锚点] 坏行跳过 + 日志文件缺失返回 []（不报错）', async () => {
    const home = tempDir('r4l7-');
    const core = makeCore(home);
    const logDir = path.join(core.config.roots.sandboxRoot, 'demo', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, 'run.jsonl'), 'broken line\n{"seq":1,"t":"x","stream":"stdout","line":"ok"}\nnot json\n', 'utf8');
    const r = await STAGES.logs(core, emptyState('demo'), { id: 'demo', tail: 10 });
    expect(r.ok).toBe(true);
    expect(r.data.count).toBe(1); // 坏行跳过
    expect(r.data.entries).toHaveLength(1);
    const missing = await STAGES.logs(core, emptyState('other'), { id: 'other', tail: 10 });
    expect(missing.ok).toBe(true);
    expect(missing.data.count).toBe(0);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

// =====================================================================
// 疑点 6：check 的冲突阻断（error vs warning）
// =====================================================================
describe('R4-6 check 冲突阻断', () => {
  it('[锚点] warning-only 冲突（非法依赖范围）不阻断：返回 OK 且 warning 级冲突透出', async () => {
    const home = tempDir('r4b1-');
    const core = makeCore(home);
    writeWarningOnlyAssembly(core);
    const r = await STAGES.check(core, emptyState('demo'), { id: 'demo' });
    expect(r.ok).toBe(true);
    expect(r.message).toContain('CHECK OK');
    expect(r.data.conflicts.some((c) => c.severity === 'warning' && c.type === 'dependency')).toBe(true);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('[锚点] error 级冲突阻断：ERR_CONFLICT_* 且 exitCode=4（仅取 severity==="error"）', async () => {
    const home = tempDir('r4b2-');
    const core = makeCore(home);
    writeConflictAssembly(core);
    const r = await STAGES.check(core, emptyState('demo'), { id: 'demo' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ERR_CONFLICT_DEPENDENCY');
    expect(r.exitCode).toBe(4);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

// =====================================================================
// 疑点 7：stageCheck 的 stateDegraded（state 损坏时过滤退化 + 显式提示）
// =====================================================================
describe('R4-7 stageCheck 的 stateDegraded', () => {
  it('[缺陷 D3] state 损坏 + 冲突（本应被隔离化解）→ check 报 ERR_CONFLICT 且 data.stateDegraded 显式透出', async () => {
    const home = tempDir('r4d1-');
    const core = makeCore(home);
    writeConflictAssembly(core);
    const state = emptyState('demo');
    state._corrupted = true; // heal.quarantined 本应有 ['pkg-b']，损坏后丢失
    const r = await STAGES.check(core, state, { id: 'demo' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ERR_CONFLICT_DEPENDENCY');
    // D3 修复：失败路径同样在 data 透出降级标记（与 OK 路径 data.stateDegraded 口径一致）。
    expect(r.data.stateDegraded).toBe(true);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('[锚点] state 未损坏 + 冲突 → data 为 null（无降级标记，对比锚点）', async () => {
    const home = tempDir('r4d2-');
    const core = makeCore(home);
    writeConflictAssembly(core);
    const r = await STAGES.check(core, emptyState('demo'), { id: 'demo' });
    expect(r.ok).toBe(false);
    expect(r.data).toBeNull();
    fs.rmSync(home, { recursive: true, force: true });
  });
});

// =====================================================================
// 疑点 9：状态机（只读命令不要求前置状态）
// =====================================================================
describe('R4-9 状态机（只读命令不要求前置状态）', () => {
  it('[锚点] check/status/logs 不在 COMMAND_PIPELINES（不会要求前置状态）', () => {
    expect(COMMAND_PIPELINES.check).toBeUndefined();
    expect(COMMAND_PIPELINES.status).toBeUndefined();
    expect(COMMAND_PIPELINES.logs).toBeUndefined();
    const r = assertCommandPipeline(STATES.IDLE, 'check');
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_ARG_UNKNOWN_COMMAND');
  });

  it('[锚点] 只读命令在无 state（phase=IDLE）时仍可执行，不被状态机拦死', async () => {
    const home = tempDir('r4s1-');
    const core = makeCore(home);
    writeCleanAssembly(core);
    setupStatusFiles(core);
    const c = await runPipeline(core, 'check', { id: 'demo' });
    expect(c.ok).toBe(true);
    const s = await runPipeline(core, 'status', { id: 'demo' });
    expect(s.ok).toBe(true);
    const l = await runPipeline(core, 'logs', { id: 'demo', tail: 5 });
    expect(l.ok).toBe(true);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('[锚点] assertCommandPipeline：未知命令→ERR_ARG_UNKNOWN_COMMAND；非法转移→ERR_ARG_BAD_STATE(exit2)；幂等重入→ok', () => {
    expect(assertCommandPipeline(STATES.IDLE, 'nope').error.code).toBe('ERR_ARG_UNKNOWN_COMMAND');
    const bad = assertCommandPipeline(STATES.IDLE, 'install');
    expect(bad.ok).toBe(false);
    expect(bad.error.code).toBe('ERR_ARG_BAD_STATE');
    expect(bad.error.exitCode).toBe(2);
    expect(assertCommandPipeline(STATES.INSTALLED, 'install').ok).toBe(true); // 幂等重入
    expect(assertCommandPipeline(STATES.MONITORING, 'launch').ok).toBe(true); // 幂等重入
  });
});

// =====================================================================
// 疑点 10：resolve/conflicts 纯函数边界（结构化结果，不抛异常）
// =====================================================================
describe('R4-10 resolve/conflicts 纯函数边界', () => {
  it('[锚点] resolvePlugins：空 plugins → ok 且空 resolved（不抛异常）', () => {
    const r = resolvePlugins({ plugins: [] }, null);
    expect(r.ok).toBe(true);
    expect(r.resolved.plugins).toEqual([]);
  });

  it('[锚点] resolvePlugins：npm 无版本 / 垃圾版本串 / path 缺 path / github 无 ref → 结构化结果不抛异常', () => {
    const noVer = resolvePlugins({ plugins: [{ id: 'a', name: 'pkg', source: { type: 'npm' }, config: {} }] }, { availableVersions: () => [] });
    expect(noVer.ok).toBe(true);
    expect(noVer.resolved.plugins[0].resolvedVersion).toBe(null);

    const garbage = resolvePlugins({ plugins: [{ id: 'a', name: 'pkg', version: 'garbage', source: { type: 'npm' }, config: {} }] }, { availableVersions: () => ['1.0.0'] });
    expect(garbage.ok).toBe(true);
    expect(garbage.resolved.plugins[0].resolvedVersion).toBe(null);

    const noPath = resolvePlugins({ plugins: [{ id: 'a', name: 'pkg', source: { type: 'path' }, config: {} }] }, null);
    expect(noPath.ok).toBe(true);
    expect(noPath.resolved.plugins[0].installPath).toBeUndefined();

    const gh = resolvePlugins({ plugins: [{ id: 'a', name: 'pkg', source: { type: 'github', repo: 'org/repo' }, config: {} }] }, null);
    expect(gh.ok).toBe(true);
    expect(gh.resolved.plugins[0].ref).toBe('main');
  });

  it('[锚点] checkConflicts：同名大小写归一冲突、role 大小写归一冲突、双无版本 warning、非法依赖范围 warning（不抛异常）', () => {
    const nameCase = checkConflicts([
      { id: 'a', name: 'Pkg', resolvedVersion: '1.0.0', config: {} },
      { id: 'b', name: 'pkg', resolvedVersion: '2.0.0', config: {} }
    ]);
    expect(nameCase.ok).toBe(false);
    expect(nameCase.conflicts.some((c) => c.type === 'version' && c.severity === 'error')).toBe(true);

    const roleCase = checkConflicts([
      { id: 'a', name: 'a', resolvedVersion: '1.0.0', config: { role: 'Search' } },
      { id: 'b', name: 'b', resolvedVersion: '1.0.0', config: { role: 'search' } }
    ]);
    expect(roleCase.ok).toBe(false);
    expect(roleCase.conflicts.some((c) => c.type === 'role' && c.severity === 'error')).toBe(true);

    const doubleNoVer = checkConflicts([
      { id: 'a', name: 'pkg', source: { type: 'path' }, version: null, resolvedVersion: null, config: {} },
      { id: 'b', name: 'pkg', source: { type: 'path' }, version: null, resolvedVersion: null, config: {} }
    ]);
    expect(doubleNoVer.ok).toBe(true);
    expect(doubleNoVer.conflicts.some((c) => c.severity === 'warning')).toBe(true);

    const badRange = checkConflicts([
      { id: 'a', name: 'a', resolvedVersion: '1.0.0', config: { dependencies: { b: 'not-a-range' } } },
      { id: 'b', name: 'b', resolvedVersion: '1.5.0', config: {} }
    ]);
    expect(badRange.ok).toBe(true);
    expect(badRange.conflicts.some((c) => c.type === 'dependency' && c.severity === 'warning')).toBe(true);
  });
});
