'use strict';
// test/audit-fixes.test.js — 架构审计回归：契约漂移 / 死代码 / 健壮性（每条曾真实失败）
//
// 1. resolveVersion：垃圾版本串在有 registry 数据时不再静默 pin 最高版（曾 pin 最高版）
// 2. versionSpec：'v1.2.3' 归一化为 '^1.2.3'（曾产出非规范 '^v1.2.3'）
// 3. planActions：显式传 null context 不再抛 TypeError（默认参数只覆盖 undefined）
// 4. classifySignal：exit exitCode=null/undefined 视为"无信号"（曾误判 CRASH_LOOP）
const { resolveVersion } = require('../domain/resolve');
const { versionSpec } = require('../domain/manifest');
const { planActions } = require('../domain/healplan');
const { classifySignal, classifyStateSignals } = require('../domain/classify');

describe('resolveVersion：垃圾版本串不被 registry 兜底 pin 最高版（审计修复）', () => {
  const registry = { availableVersions: () => ['1.0.0', '2.0.0'] };
  it('garbage 版本串 → unresolved + warning（此前 pin 2.0.0）', () => {
    const r = resolveVersion('pkg', 'garbage!@#', registry);
    expect(r.resolvedVersion).toBeNull();
    expect(r.pinned).toBe(false);
    expect(r.source).toBe('unresolved');
    expect(r.warning).toContain('非法版本串');
  });
  it('精确版仍直接 pin', () => {
    const r = resolveVersion('pkg', '1.2.3', registry);
    expect(r).toEqual({ resolvedVersion: '1.2.3', pinned: true, source: 'exact' });
  });
  it('合法范围仍走 registry 匹配', () => {
    const r = resolveVersion('pkg', '^1.0.0', registry);
    expect(r.pinned).toBe(true);
    expect(r.resolvedVersion).toBe('1.0.0');
  });
});

describe('versionSpec：v 前缀归一化（审计修复）', () => {
  it("versionSpec('v1.2.3') → '^1.2.3'（此前 '^v1.2.3'）", () => {
    expect(versionSpec('v1.2.3')).toBe('^1.2.3');
  });
  it('精确版 → ^；范围 → 原样；tag → 原样；垃圾 → latest', () => {
    expect(versionSpec('1.2.3')).toBe('^1.2.3');
    expect(versionSpec('^1.0.0')).toBe('^1.0.0');
    expect(versionSpec('latest')).toBe('latest');
    expect(versionSpec('garbage')).toBe('latest');
    expect(versionSpec(undefined)).toBe('latest');
  });
});

describe('planActions：null context 健壮性（审计修复）', () => {
  it('planActions(classification, null) 不抛 TypeError', () => {
    const r = planActions([{ action: 'CRASH_LOOP' }], null);
    expect(r.ok).toBe(true);
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0].code).toBe('CRASH_LOOP');
    expect(r.actions[0].dryRun).toBe(true);
  });
});

describe('classifySignal：exit 无退出码视为无信号（审计修复）', () => {
  it('exitCode null/undefined → null（此前误判 CRASH_LOOP）', () => {
    expect(classifySignal({ kind: 'exit', exitCode: null })).toBeNull();
    expect(classifySignal({ kind: 'exit', exitCode: undefined })).toBeNull();
  });
  it('classifyStateSignals：lastExit null 仍为无信号（回归不变）', () => {
    expect(classifyStateSignals({ launch: { lastExit: null, retries: 3 } })).toEqual([]);
  });
});
