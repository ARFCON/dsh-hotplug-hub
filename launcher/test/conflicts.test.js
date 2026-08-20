'use strict';
// test/conflicts.test.js — semver 冲突矩阵（I 回归）
const { checkConflicts } = require('../domain/conflicts');

describe('domain/conflicts semver 冲突矩阵（审计 I 回归）', () => {
  it('同名不同版本 → error 级冲突（semver.neq）', () => {
    const plugins = [
      { id: 'a', name: 'pkg', source: { type: 'npm' }, resolvedVersion: '1.2.3' },
      { id: 'b', name: 'pkg', source: { type: 'npm' }, resolvedVersion: '1.2.4' }
    ];
    const r = checkConflicts(plugins);
    expect(r.ok).toBe(false);
    expect(r.conflicts.some((c) => c.severity === 'error' && c.type === 'version')).toBe(true);
  });

  it('双无版本 → warning 不漏报（I 修复：undefined===undefined 漏报）', () => {
    const plugins = [
      { id: 'a', name: 'pkg', source: { type: 'path' }, version: null, resolvedVersion: null },
      { id: 'b', name: 'pkg', source: { type: 'path' }, version: null, resolvedVersion: null }
    ];
    const r = checkConflicts(plugins);
    expect(r.ok).toBe(true); // 无 error
    expect(r.conflicts.some((c) => c.severity === 'warning')).toBe(true);
  });

  it('同名同版本 → 无 error', () => {
    const plugins = [
      { id: 'a', name: 'pkg', source: { type: 'npm' }, resolvedVersion: '1.2.3' },
      { id: 'b', name: 'pkg', source: { type: 'npm' }, resolvedVersion: '1.2.3' }
    ];
    const r = checkConflicts(plugins);
    expect(r.ok).toBe(true);
    expect(r.conflicts.filter((c) => c.severity === 'error').length).toBe(0);
  });

  it('重复角色 → error', () => {
    const plugins = [
      { id: 'a', name: 'a', source: { type: 'npm' }, resolvedVersion: '1.0.0', config: { role: '搜索' } },
      { id: 'b', name: 'b', source: { type: 'npm' }, resolvedVersion: '1.0.0', config: { role: '搜索' } }
    ];
    const r = checkConflicts(plugins);
    expect(r.ok).toBe(false);
    expect(r.conflicts.some((c) => c.type === 'role')).toBe(true);
  });

  it('依赖图冲突：声明范围不被满足 → error', () => {
    const plugins = [
      { id: 'a', name: 'a', source: { type: 'npm' }, resolvedVersion: '1.0.0', config: { dependencies: { b: '^2.0.0' } } },
      { id: 'b', name: 'b', source: { type: 'npm' }, resolvedVersion: '1.5.0' }
    ];
    const r = checkConflicts(plugins);
    expect(r.ok).toBe(false);
    expect(r.conflicts.some((c) => c.type === 'dependency')).toBe(true);
  });

  it('依赖图冲突：范围被满足 → 无 error', () => {
    const plugins = [
      { id: 'a', name: 'a', source: { type: 'npm' }, resolvedVersion: '1.0.0', config: { dependencies: { b: '^1.0.0' } } },
      { id: 'b', name: 'b', source: { type: 'npm' }, resolvedVersion: '1.5.0' }
    ];
    const r = checkConflicts(plugins);
    expect(r.ok).toBe(true);
  });
});
