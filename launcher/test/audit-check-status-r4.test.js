'use strict';
// test/audit-check-status-r4.test.js — 自检（check/status/logs 只读诊断）深度审计（R4，A 部分）
//
// 本文件针对审计疑点逐条用真实测试钉死。每处标注：
//   [缺陷]  —— 测试失败、证明真实缺陷（代码行为违反契约/自相矛盾）
//   [锚点]  —— 测试通过、钉死"不是缺陷"的正确行为（防回归）
//   [记录]  —— 测试通过、记录当前语义（潜在混淆/需进一步确认）
//
// 已知真实缺陷（已修复，测试锁定修复后行为）：
//   D1  errResult 的 exitCode 由 code 推导（不再用 error.exitCode 兜底）
//   D2  stageStatus.crashLooping 与 classifyStateSignals 共用单一真源谓词（消除漏判/误判）
//   D3  stageCheck 的 stateDegraded 在失败路径同样经 data 透出
const fs = require('fs');
const path = require('path');
const { STAGES } = require('../app/stages');
const { runPipeline } = require('../app/pipeline');
const { createFsPort } = require('../ports/fs');
const { createProcPort } = require('../ports/proc');
const { okResult, errResult, quarantinedNames } = require('../app/stages-util');
const { classifyStateSignals } = require('../domain/classify');
const { makeError } = require('../contracts/errors');
const { tempDir } = require('./helpers');
const {
  CRASH_LOOP_THRESHOLD, emptyState, makeCore,
  writeCleanAssembly, writeRoleConflictAssembly, setupStatusFiles, setupHealthyFiles, writeLogFile
} = require('./audit-check-status-common');

// =====================================================================
// 疑点 8：okResult / errResult 契约
// =====================================================================
describe('R4-8 okResult/errResult 契约', () => {
  it('[锚点] okResult：code 恒 "OK"、exitCode 恒 0', () => {
    const r = okResult('done', { x: 1 });
    expect(r.ok).toBe(true);
    expect(r.code).toBe('OK');
    expect(r.exitCode).toBe(0);
  });

  it('[锚点] errResult(makeError(...))：exitCode 与 code 一致（正常路径）', () => {
    const e = makeError('ERR_LAUNCH_EXIT', 'x');
    const r = errResult(e);
    expect(r.code).toBe('ERR_LAUNCH_EXIT');
    expect(r.exitCode).toBe(8); // 8 = ERR_LAUNCH_ 前缀
  });

  it('[缺陷 D1] exitCode 必须由 code 推导，不得用 error.exitCode 兜底（脱钩值会污染契约码）', () => {
    // 手构造一个 code/exitCode 脱钩的 error：exitCode 必须由 code 推导为 8（而非脱钩的 1）。
    const r = errResult({ code: 'ERR_LAUNCH_EXIT', message: 'boom', exitCode: 1 });
    expect(r.code).toBe('ERR_LAUNCH_EXIT');
    expect(r.exitCode).toBe(8);
  });

  it('[缺陷 D1] 无 code 但有 error.exitCode 时，兜底 ERR_ENV_UNSUPPORTED→12（脱钩值不得覆盖）', () => {
    const r = errResult({ message: 'no code', exitCode: 5 });
    expect(r.code).toBe('ERR_ENV_UNSUPPORTED');
    expect(r.exitCode).toBe(12);
  });

  it('[锚点] errResult 传入非 Error（字符串/null/undefined）不抛异常，code 兜底 ERR_ENV_UNSUPPORTED', () => {
    expect(() => errResult('boom')).not.toThrow();
    expect(() => errResult(null)).not.toThrow();
    expect(() => errResult(undefined)).not.toThrow();
    expect(errResult('boom').code).toBe('ERR_ENV_UNSUPPORTED');
    expect(errResult('boom').exitCode).toBe(12);
    expect(errResult(null).code).toBe('ERR_ENV_UNSUPPORTED');
    expect(errResult(undefined).code).toBe('ERR_ENV_UNSUPPORTED');
  });
});

// =====================================================================
// 疑点 1：零副作用契约（零写盘、零子进程）
// =====================================================================
describe('R4-1 零副作用契约', () => {
  function spyFsPort() {
    const port = createFsPort(fs); // 读方法委托真实 fs
    const writeCalls = [];
    const writeMethods = ['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmdirSync',
      'copyFileSync', 'renameSync', 'unlinkSync', 'rmSync', 'symlinkSync', 'writeSync',
      'ftruncateSync', 'fsyncSync'];
    for (const m of writeMethods) {
      port[m] = (...a) => { writeCalls.push(m); throw new Error('READ-ONLY VIOLATION: ' + m); };
    }
    return { port, writeCalls };
  }

  function spyProcPort() {
    const calls = [];
    const port = createProcPort({
      spawn: () => { calls.push('spawn'); throw new Error('spawn forbidden'); },
      spawnSync: () => { calls.push('spawnSync'); throw new Error('spawnSync forbidden'); }
    });
    return { port, calls };
  }

  it('[锚点] check/status/logs 全程零写盘、零子进程（注入写盘即抛/子进程即抛的端口仍可完成）', async () => {
    const home = tempDir('r4z1-');
    const core = makeCore(home);
    writeCleanAssembly(core);
    setupStatusFiles(core);
    writeLogFile(core, 'demo', ['hello'], []);

    const fsSpy = spyFsPort();
    const procSpy = spyProcPort();
    core.ports.fs = fsSpy.port;
    core.ports.proc = procSpy.port;

    const c = await STAGES.check(core, emptyState('demo'), { id: 'demo' });
    const s = await STAGES.status(core, emptyState('demo'), { id: 'demo' });
    const l = await STAGES.logs(core, emptyState('demo'), { id: 'demo', tail: 5 });

    expect(c.ok).toBe(true);
    expect(s.ok).toBe(true); // status 永远 ok（报告健康度）；findHarness 用 probe:false 不 spawn
    expect(l.ok).toBe(true);
    expect(fsSpy.writeCalls).toEqual([]); // 零写盘
    expect(procSpy.calls).toEqual([]);    // 零子进程（含 status 的 harness 探测）
    fs.rmSync(home, { recursive: true, force: true });
  });
});

// =====================================================================
// 疑点 2：只读命令的 state 损坏降级
// =====================================================================
describe('R4-2 只读命令 state 损坏降级', () => {
  const corrupt = (core, id = 'demo') => {
    const storeDir = path.join(core.config.roots.storeRoot, id);
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(path.join(storeDir, 'state.json'), '{ "phase": "RUNN');
  };

  it('[锚点] state 损坏 + 无冲突 assembly → check 仍 OK 且显式 stateDegraded:true', async () => {
    const home = tempDir('r4c1-');
    const core = makeCore(home);
    writeCleanAssembly(core);
    corrupt(core);
    const r = await runPipeline(core, 'check', { id: 'demo' });
    expect(r.ok).toBe(true);
    expect(r.data.stateDegraded).toBe(true);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('[锚点] state 损坏 → status 诚实降级 DEGRADED + stateOk:false（不拦死）', async () => {
    const home = tempDir('r4c2-');
    const core = makeCore(home);
    setupHealthyFiles(core);
    corrupt(core);
    const r = await runPipeline(core, 'status', { id: 'demo' });
    expect(r.ok).toBe(true);
    expect(r.data.healthy).toBe(false);
    expect(r.data.stateOk).toBe(false);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('[锚点] state 损坏 → logs 仍可读（与 state 无关）', async () => {
    const home = tempDir('r4c3-');
    const core = makeCore(home);
    writeLogFile(core, 'demo', ['a', 'b'], []);
    corrupt(core);
    const r = await runPipeline(core, 'logs', { id: 'demo', tail: 5 });
    expect(r.ok).toBe(true);
    expect(r.data.count).toBe(2);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

// =====================================================================
// 疑点 3：check↔assemble 判定漂移（quarantinedNames 单一真源）
// =====================================================================
describe('R4-3 check↔assemble 判定漂移', () => {
  it('[锚点] 角色冲突插件被隔离后 check 转绿（与 assemble 同一 quarantinedNames 过滤）', async () => {
    const home = tempDir('r4q1-');
    const core = makeCore(home);
    writeRoleConflictAssembly(core);
    const quarantined = emptyState('demo', { heal: { history: [], quarantined: ['pkg-b'] } });
    const r = await STAGES.check(core, quarantined, { id: 'demo' });
    expect(r.ok).toBe(true);
    expect(r.message).toContain('CHECK OK');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('[锚点] 未隔离时同一角色冲突 assembly 仍报 ERR_CONFLICT_ROLE（过滤不是绕过）', async () => {
    const home = tempDir('r4q2-');
    const core = makeCore(home);
    writeRoleConflictAssembly(core);
    const r = await STAGES.check(core, emptyState('demo'), { id: 'demo' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ERR_CONFLICT_ROLE');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('[锚点] quarantinedNames：隔离名单按 name 精确过滤（单一真源语义）', () => {
    const state = emptyState('demo', { heal: { history: [], quarantined: ['pkg-b'] } });
    expect(quarantinedNames(state)).toEqual(['pkg-b']);
    expect(quarantinedNames(emptyState('demo'))).toEqual([]);
    expect(quarantinedNames({ phase: 'IDLE' })).toEqual([]);
  });
});

// =====================================================================
// 疑点 4：stageStatus healthy 完整性（crashLooping 单一真源）
// =====================================================================
describe('R4-4 stageStatus healthy 完整性', () => {
  it('[锚点] 三件套完好 + 无任何不健康信号 → STATUS OK', async () => {
    const home = tempDir('r4h0-');
    const core = makeCore(home);
    setupHealthyFiles(core);
    const r = await STAGES.status(core, emptyState('demo'), { id: 'demo' });
    expect(r.data.healthy).toBe(true);
    expect(r.message).toBe('STATUS OK');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('[缺陷 D2-①] INSTALLED 阶段连续崩溃（retries≥3 且 lastExit≠0）：status 与 heal 同判 crashLooping', async () => {
    const home = tempDir('r4h1-');
    const core = makeCore(home);
    setupHealthyFiles(core);
    // 真实可达形态：install 成功（phase=INSTALLED）后 launch 反复失败，retries 累加，
    // phase 始终未被推入 MONITORING（detach 启动从未成功过）。
    const state = emptyState('demo', {
      phase: 'INSTALLED',
      launch: { lastExit: 1, lastStart: null, retries: CRASH_LOOP_THRESHOLD, pid: null }
    });
    expect(classifyStateSignals(state).some((s) => s.action === 'CRASH_LOOP')).toBe(true);
    const r = await STAGES.status(core, state, { id: 'demo' });
    expect(r.data.crashLooping).toBe(true); // 不再漏判（去掉 phase===MONITORING 额外约束）
    expect(r.data.healthy).toBe(false);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('[缺陷 D2-②] spawn 错误（lastExit=null + spawnCode）不误报 crashLooping（classify 判 HARNESS_FIX）', async () => {
    const home = tempDir('r4h2-');
    const core = makeCore(home);
    setupHealthyFiles(core);
    const state = emptyState('demo', {
      phase: 'MONITORING',
      launch: { lastExit: null, lastStart: null, retries: CRASH_LOOP_THRESHOLD, pid: null, spawnCode: 'ENOENT' }
    });
    const signals = classifyStateSignals(state);
    expect(signals.some((s) => s.action === 'CRASH_LOOP')).toBe(false);
    expect(signals.some((s) => s.action === 'HARNESS_FIX')).toBe(true);
    const r = await STAGES.status(core, state, { id: 'demo' });
    expect(r.data.crashLooping).toBe(false); // 不再误报（spawnCode 与崩溃循环互斥）
    fs.rmSync(home, { recursive: true, force: true });
  });
});
