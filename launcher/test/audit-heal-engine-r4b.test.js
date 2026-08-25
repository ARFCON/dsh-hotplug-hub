'use strict';
// test/audit-heal-engine-r4b.test.js — 「自检自愈」引擎深度审计（R4，B 部分）
// 承接 audit-heal-engine-r4.test.js（A 部分）。
// 覆盖疑点（B 部分）：7 信号分类边界 / 8 executeAction 裸抛 / 9 契约统一 / 10 并发/隔离。
const fs = require('fs');
const path = require('path');
const { classifySignal } = require('../domain/classify');
const { executeAction } = require('../infra/heal-steps');
const { verifyAction } = require('../infra/heal-verify');
const { runHeal } = require('../infra/heal');
const { isDshError, ERROR_CODES, makeError } = require('../contracts/errors');
const { createFsPort } = require('../ports/fs');
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

// 让一个 Promise 落地为 {resolved, value|error}，用于「不得裸抛」的契约断言
function settle(p) {
  return p.then(
    (value) => ({ resolved: true, value }),
    (error) => ({ resolved: false, error })
  );
}

// =====================================================================
// 疑点 7：信号分类边界（零误报/零漏报/零崩溃）
// =====================================================================
describe('R4-7 信号分类边界', () => {
  it('证实：spawn-error code 边界（ENOENT/EACCES/EPERM/UNKNOWN/undefined/null）零崩溃且归因正确', () => {
    expect(classifySignal({ kind: 'spawn-error', err: { code: 'ENOENT' } }).action).toBe('HARNESS_FIX');
    expect(classifySignal({ kind: 'spawn-error', err: { code: 'EACCES' } }).action).toBe('INSTALL_FAIL');
    expect(classifySignal({ kind: 'spawn-error', err: { code: 'EPERM' } }).action).toBe('INSTALL_FAIL');
    expect(classifySignal({ kind: 'spawn-error', err: { code: 'UNKNOWN' } }).action).toBe('HARNESS_FIX');
    expect(classifySignal({ kind: 'spawn-error', err: { code: undefined } }).action).toBe('HARNESS_FIX');
    expect(classifySignal({ kind: 'spawn-error', err: { code: null } }).action).toBe('HARNESS_FIX');
    expect(classifySignal({ kind: 'spawn-error' }).action).toBe('HARNESS_FIX');
    expect(classifySignal({ kind: 'spawn-error', err: null }).action).toBe('HARNESS_FIX');
  });

  it('证实：exit code 0/null/undefined → 无信号（零误报，detach 存活不误判崩溃）', () => {
    expect(classifySignal({ kind: 'exit', exitCode: 0 })).toBeNull();
    expect(classifySignal({ kind: 'exit', exitCode: null })).toBeNull();
    expect(classifySignal({ kind: 'exit', exitCode: undefined })).toBeNull();
  });

  it('证实：stderr 空行/非字符串/无锚定 → 零误报且不崩溃', () => {
    expect(classifySignal({ kind: 'stderr', line: '' })).toBeNull();
    expect(classifySignal({ kind: 'stderr', line: undefined })).toBeNull();
    expect(classifySignal({ kind: 'stderr', line: 42 })).toBeNull();
    expect(classifySignal({ kind: 'stderr', line: { a: 1 } })).toBeNull();
    expect(classifySignal({ kind: 'stderr', line: 'INFO: AUTH service started, 401 connections' })).toBeNull();
  });

  it('证实：log severity 非 error → 无信号（零误报）', () => {
    expect(classifySignal({ kind: 'log', severity: 'warn', message: 'Error: ENOENT: x' })).toBeNull();
    expect(classifySignal({ kind: 'log', severity: 'info', message: 'Error: ENOENT: x' })).toBeNull();
    expect(classifySignal({ kind: 'log', message: 'Error: ENOENT: x' })).toBeNull();
  });

  it('证实：signal null/undefined/非对象/未知 kind → null（零崩溃）', () => {
    expect(classifySignal(null)).toBeNull();
    expect(classifySignal(undefined)).toBeNull();
    expect(classifySignal(42)).toBeNull();
    expect(classifySignal('x')).toBeNull();
    expect(classifySignal({ kind: 'no-such-kind' })).toBeNull();
  });

  it('H5 修复后：exitCode 为字符串 "0"（语义等同成功退出）→ 无信号（不误判崩溃循环）', () => {
    expect(classifySignal({ kind: 'exit', exitCode: '0' })).toBeNull();
    expect(classifySignal({ kind: 'exit', exitCode: '' })).toBeNull();
    expect(classifySignal({ kind: 'exit', exitCode: false })).toBeNull();
  });
});

// =====================================================================
// 疑点 8：executeAction 各 step 失败路径（不得裸抛）
// =====================================================================
describe('R4-8 executeAction 失败路径不得裸抛', () => {
  it('H6 修复后：mirror-retry 的 onMirror 抛异常 → 归一为 {ok:false,error}（不裸抛）', async () => {
    const onMirror = async () => { throw new Error('boom'); };
    const s = await settle(executeAction(makeCore(),
      { code: 'GITHUB_ACQUIRE_FAIL', steps: [{ type: 'mirror-retry', mirrors: ['m1'] }] }, { onMirror }));
    expect(s.resolved).toBe(true);
    expect(s.value.ok).toBe(false);
  });

  it('H6 修复后：reprobe-harness 的 findHarness 抛异常 → 归一为 {ok:false,error}（不裸抛）', async () => {
    const core = makeCore({ infra: { harness: { findHarness: () => { throw new Error('boom'); } } } });
    const s = await settle(executeAction(core, { code: 'HARNESS_FIX', steps: [{ type: 'reprobe-harness' }] }, {}));
    expect(s.resolved).toBe(true);
    expect(s.value.ok).toBe(false);
  });

  it('H6 修复后：executeAction 收到 null ctx → 显式 {ok:false,error}（不裸抛）', async () => {
    const s = await settle(executeAction(makeCore(), { code: 'INSTALL_FAIL', steps: [{ type: 'reinstall' }] }, null));
    expect(s.resolved).toBe(true);
    expect(s.value.ok).toBe(false);
    expect(s.value.error.code).toBe('ERR_HEAL_BUDGET');
  });

  it('H6 修复后：verifyAction HARNESS_FIX 的 findHarness 抛异常 → 归一为 {ok:false,error}', async () => {
    const core = makeCore({ infra: { harness: { findHarness: () => { throw new Error('boom'); } } } });
    const s = await settle(verifyAction(core, { code: 'HARNESS_FIX' }, {}));
    expect(s.resolved).toBe(true);
    expect(s.value.ok).toBe(false);
  });

  it('H6 修复后：runHeal 不再被 executeAction 裸抛穿透（整体 resolved 为 {ok:false,error}）', async () => {
    const onMirror = async () => { throw new Error('boom'); };
    const action = { code: 'GITHUB_ACQUIRE_FAIL', steps: [{ type: 'mirror-retry', mirrors: ['m1'] }], budget: 2, rollback: 'x' };
    const s = await settle(runHeal(makeCore(), [action], { state: {}, profile: tempDir('r4-runheal-throw-'), plugins: [], onMirror }, { dryRun: false }));
    expect(s.resolved).toBe(true);
    expect(s.value.ok).toBe(false);
  });

  it('证实：损坏 manifest / registry 抛错等已知异常路径确实返回 {ok:false,error}（对照组）', async () => {
    const profile = tempDir('r4-bad-manifest-');
    fs.writeFileSync(path.join(profile, 'package.json'), '{bad');
    const r1 = await executeAction(makeCore(), { code: 'BUNDLE_MISCLASSIFY', steps: [{ type: 'reclassify-bundles' }] }, { plugins: [], profile });
    expect(r1.ok).toBe(false);
    expect(r1.error.code).toBe('ERR_HEAL_ROLLBACK');
    const core2 = makeCore({ ports: { fs: fsPort, registry: { availableVersions: () => { throw new Error('ECONNREFUSED'); } } } });
    const r2 = await executeAction(core2, { code: 'REGISTRY_UNAVAILABLE', steps: [{ type: 'reprobe-registry' }] }, {});
    expect(r2.ok).toBe(false);
    expect(r2.error.code).toBe('ERR_INSTALL_ACQUIRE');
    fs.rmSync(profile, { recursive: true, force: true });
  });
});

// =====================================================================
// 疑点 9：契约统一（makeError / isDshError）
// =====================================================================
describe('R4-9 契约统一', () => {
  it('证实：runHeal 失败错误为 isDshError 且 code 在 ERROR_CODES 内（无裸 Error）', async () => {
    const action = { code: 'CRASH_LOOP', steps: [{ type: 'no-such-step' }], budget: 0, rollback: 'x' };
    const r = await runHeal(makeCore(), [action], { state: {}, profile: tempDir('r4-contract-'), plugins: [] }, { dryRun: false });
    expect(r.ok).toBe(false);
    expect(isDshError(r.error)).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(ERROR_CODES, r.error.code)).toBe(true);
  });

  it('证实：makeError 拒绝 ERROR_CODES 外的 code（M-37 声明内校验，防契约外错误形态）', () => {
    expect(() => makeError('NOT_A_DECLARED_CODE', 'x')).toThrow(TypeError);
    expect(() => makeError(null, 'x')).toThrow(TypeError);
    expect(ERROR_CODES.ERR_HEAL_BUDGET).toBe('ERR_HEAL_BUDGET');
  });
});

// =====================================================================
// 疑点 10：并发/隔离（写命令锁覆盖 heal + 失败路径持久化）
// =====================================================================
describe('R4-10 并发/隔离', () => {
  it('证实：写命令锁覆盖 heal（pipeline WRITE_COMMANDS 含 heal，防 launch/heal 撕裂 state）', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'pipeline.js'), 'utf8');
    const m = src.match(/WRITE_COMMANDS\s*=\s*new Set\(\[([^\]]*)\]\)/);
    expect(m).not.toBeNull();
    expect(m[1]).toContain("'heal'");
  });

  it('证实：heal 失败（budget 超限）路径 state.dirty=true 且 history 持久化（stageHeal 层）', async () => {
    const { createCore } = require('../app/create-core');
    const { createProcPort } = require('../ports/proc');
    const { stageHeal } = require('../app/stages-heal');
    const home = tempDir('r4-persist-');
    const core = createCore({
      baseDir: path.join(__dirname, '..'),
      home,
      env: isolatedEnv(home),
      procPort: createProcPort({ spawn: () => { throw new Error('no spawn'); }, spawnSync: () => ({ status: 1, error: null, stderr: '', stdout: '' }) })
    });
    const id = 'r4-persist-a';
    // 无快照 + 无插件：rollback-snapshot 跳过、disable-recent 无插件可禁用 → CRASH_LOOP 失败
    const state = { id, phase: 'LAUNCHED', launch: { lastExit: 1, retries: 3, lastStart: new Date().toISOString() }, heal: {}, resolved: { plugins: [] } };
    const r = await stageHeal(core, state, { id, yes: true });
    expect(r.ok).toBe(false);
    expect(state.phase).toBe('QUARANTINED');
    expect(state.dirty).toBe(true);
    expect((state.heal.history || []).length).toBeGreaterThan(0);
    fs.rmSync(path.join(core.config.roots.sandboxRoot, id), { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
});
