'use strict';
// test/audit-r5-heal-A.test.js — 「自愈引擎」R5 独立审计（A 部分）
//
// 本文件为全新一轮独立审计：不信任任何既有结论，亲自读源码、亲自验证。
// 每个测试都钉死一个【当前会 FAIL（红）】的真实缺陷，不改任何源码、不改既有测试。
// 运行：npx vitest run test/audit-r5-heal-A.test.js
//
// 钉死的缺陷：
//   A1 domain/classify.js：classifySignal('exit') 与 isCrashLooping 用 Number()
//      强转判定「非零退出」，把布尔 true、数字字符串 '1'、单元素数组 [1] 等
//      「非规范形态」误判为 CRASH_LOOP——直接违背该文件自身声明的
//      「字符串/布尔等非规范形态一律视为无信号」契约（H5 注释，classify.js:83-84）。
//      根因：Number(true)===1 / Number('1')===1 / Number([1])===1，都是有限非零，
//      使 `Number.isFinite(code) && code !== 0` 无法区分「真数字 1」与「可强转为 1
//      的非数字」。正确判定应为 `typeof x === 'number' && Number.isFinite(x) && x !== 0`。
//      既有测试只覆盖了会强转为 0 的形态（'0'/''/false），漏掉了会强转为非 0 的形态。
//
//   A2 infra/heal-steps.js + infra/heal-verify.js：reprobe-registry 步骤与
//      REGISTRY_UNAVAILABLE 验证调用 `reg.availableVersions('__probe__')` 既不 await、
//      也不校验返回值类型，且 try/catch 只能捕获「同步 throw」。异步 registry 端口
//      （availableVersions 返回 Promise）的失败被静默吞掉 → 误报 ok:true（假自愈），
//      且 Promise 拒绝成为未处理拒绝。这与同文件 onMirror（已 `await ctx.onMirror(...)`）
//      及 domain/resolve.js resolveVersion（用 `Array.isArray(got)` 防御 Promise 返回值）
//      的口径不一致。
const { classifySignal, isCrashLooping } = require('../domain/classify');
const { executeAction } = require('../infra/heal-steps');
const { verifyAction } = require('../infra/heal-verify');
const { createFsPort } = require('../ports/fs');
const fs = require('fs');

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

// =====================================================================
// A1：classifySignal / isCrashLooping 的 Number() 强转缺陷
// 契约（classify.js:83-84 注释）：「仅『有限数字且非零』才触发崩溃循环——
// 字符串/布尔等非规范形态一律视为无信号」。
// =====================================================================
describe('R5-A1 classifySignal/isCrashLooping：Number() 强转破坏「非规范形态一律视为无信号」', () => {
  it('exit：exitCode=true（布尔）必须无信号，现被 Number(true)=1 误判为 CRASH_LOOP', () => {
    expect(classifySignal({ kind: 'exit', exitCode: true })).toBeNull();
  });

  it('exit：exitCode=\'1\'（数字字符串）必须无信号，现被 Number(\'1\')=1 误判为 CRASH_LOOP', () => {
    expect(classifySignal({ kind: 'exit', exitCode: '1' })).toBeNull();
  });

  it('exit：exitCode=[1]（单元素数组）必须无信号，现被 Number([1])=1 误判为 CRASH_LOOP', () => {
    expect(classifySignal({ kind: 'exit', exitCode: [1] })).toBeNull();
  });

  it('isCrashLooping：lastExit=true（布尔）必须 false，现被 Number(true)=1 误判为 true', () => {
    expect(isCrashLooping({ launch: { lastExit: true, retries: 3 } })).toBe(false);
  });

  it('isCrashLooping：lastExit=\'1\'（数字字符串）必须 false，现被 Number(\'1\')=1 误判为 true', () => {
    expect(isCrashLooping({ launch: { lastExit: '1', retries: 3 } })).toBe(false);
  });
});

// =====================================================================
// A2：异步 registry 端口未 await / 返回值非法 → 误报 ok:true（假自愈）+ 未处理拒绝
// 契约：自愈「执行 + 验证」必须诚实——异步端口的失败（Promise 拒绝）与非法返回值
// 都必须被捕获并归一为 {ok:false, error}，绝不静默 ok:true。
// =====================================================================
describe('R5-A2 异步 registry 端口必须 await 并校验返回值', () => {
  it('reprobe-registry 步骤：availableVersions 返回拒绝的 Promise → 必须 ok:false + ERR_INSTALL_ACQUIRE', async () => {
    const core = makeCore({
      ports: { fs: fsPort, registry: { availableVersions: () => Promise.reject(new Error('ECONNREFUSED')) } }
    });
    const r = await executeAction(core, {
      code: 'REGISTRY_UNAVAILABLE',
      steps: [{ type: 'reprobe-registry' }]
    }, {});
    expect(r.ok).toBe(false);
    expect(r.error && r.error.code).toBe('ERR_INSTALL_ACQUIRE');
  });

  it('reprobe-registry 步骤：availableVersions 返回非数组（非法返回值）→ 必须 ok:false + ERR_INSTALL_ACQUIRE', async () => {
    const core = makeCore({
      ports: { fs: fsPort, registry: { availableVersions: () => undefined } }
    });
    const r = await executeAction(core, {
      code: 'REGISTRY_UNAVAILABLE',
      steps: [{ type: 'reprobe-registry' }]
    }, {});
    expect(r.ok).toBe(false);
    expect(r.error && r.error.code).toBe('ERR_INSTALL_ACQUIRE');
  });

  it('REGISTRY_UNAVAILABLE 验证：availableVersions 返回拒绝的 Promise → 必须 ok:false + ERR_INSTALL_ACQUIRE', async () => {
    const core = makeCore({
      ports: { fs: fsPort, registry: { availableVersions: () => Promise.reject(new Error('ECONNREFUSED')) } }
    });
    const r = await verifyAction(core, { code: 'REGISTRY_UNAVAILABLE' }, {});
    expect(r.ok).toBe(false);
    expect(r.error && r.error.code).toBe('ERR_INSTALL_ACQUIRE');
  });

  it('REGISTRY_UNAVAILABLE 验证：availableVersions 返回非数组 → 必须 ok:false + ERR_INSTALL_ACQUIRE', async () => {
    const core = makeCore({
      ports: { fs: fsPort, registry: { availableVersions: () => 'not-an-array' } }
    });
    const r = await verifyAction(core, { code: 'REGISTRY_UNAVAILABLE' }, {});
    expect(r.ok).toBe(false);
    expect(r.error && r.error.code).toBe('ERR_INSTALL_ACQUIRE');
  });
});
