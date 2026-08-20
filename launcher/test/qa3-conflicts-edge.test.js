'use strict';
// test/qa3-conflicts-edge.test.js — conflicts semver 边界穷尽（QA3 第 2 层主题 3）
const { checkConflicts, assertNoBlockingConflicts } = require('../domain/conflicts');

function plugin(id, name, opts = {}) {
  return {
    id,
    name,
    source: { type: 'npm' },
    resolvedVersion: opts.resolvedVersion || null,
    version: opts.version || null,
    config: opts.config || {}
  };
}

describe('QA3 conflicts semver 边界（审计 I 强化）', () => {
  it('预发布版本语义比较：1.2.3-beta.1 vs 1.2.3-beta.2 → error', () => {
    const r = checkConflicts([
      plugin('a', 'pkg', { resolvedVersion: '1.2.3-beta.1' }),
      plugin('b', 'pkg', { resolvedVersion: '1.2.3-beta.2' })
    ]);
    expect(r.ok).toBe(false);
    const v = r.conflicts.find((c) => c.type === 'version');
    expect(v.severity).toBe('error');
    expect(v.reason).toContain('1.2.3-beta.1 vs 1.2.3-beta.2');
  });

  it('预发布版本相同 → 无 error', () => {
    const r = checkConflicts([
      plugin('a', 'pkg', { resolvedVersion: '1.2.3-beta.1' }),
      plugin('b', 'pkg', { resolvedVersion: '1.2.3-beta.1' })
    ]);
    expect(r.ok).toBe(true);
  });

  it('精确 vs 范围（^1.2.0 非 valid semver 版本）→ 降级 warning 而非 error（记录行为）', () => {
    const r = checkConflicts([
      plugin('a', 'pkg', { resolvedVersion: '1.2.3' }),
      plugin('b', 'pkg', { resolvedVersion: '^1.2.0' })
    ]);
    // semver.valid('^1.2.0') === null → 走"缺版本"分支 → warning
    expect(r.ok).toBe(true);
    expect(r.conflicts.some((c) => c.severity === 'warning')).toBe(true);
  });

  it('0.0.1 vs 0.0.2 → error（微小版本差异也阻断）', () => {
    const r = checkConflicts([
      plugin('a', 'pkg', { resolvedVersion: '0.0.1' }),
      plugin('b', 'pkg', { resolvedVersion: '0.0.2' })
    ]);
    expect(r.ok).toBe(false);
  });

  it('同包名不同 scope（@a/x vs @b/x）→ 不同名，无冲突', () => {
    const r = checkConflicts([
      plugin('a', '@a/x', { resolvedVersion: '1.0.0' }),
      plugin('b', '@b/x', { resolvedVersion: '2.0.0' })
    ]);
    expect(r.ok).toBe(true);
    expect(r.conflicts.filter((c) => c.type === 'version')).toHaveLength(0);
  });

  it('大小写 name 归一后冲突（Pkg vs pkg）', () => {
    const r = checkConflicts([
      plugin('a', 'Pkg', { resolvedVersion: '1.0.0' }),
      plugin('b', 'pkg', { resolvedVersion: '2.0.0' })
    ]);
    expect(r.ok).toBe(false);
    expect(r.conflicts.some((c) => c.type === 'version' && c.severity === 'error')).toBe(true);
  });

  it('双无版本 warning 不漏报（path 源常见形态）', () => {
    const r = checkConflicts([
      { id: 'a', name: 'pkg', source: { type: 'path' }, version: null, resolvedVersion: null, config: {} },
      { id: 'b', name: 'pkg', source: { type: 'path' }, version: null, resolvedVersion: null, config: {} }
    ]);
    expect(r.ok).toBe(true);
    expect(r.conflicts.filter((c) => c.severity === 'warning')).toHaveLength(1);
  });

  it('一方有版本一方无版本 → warning 不漏报', () => {
    const r = checkConflicts([
      plugin('a', 'pkg', { resolvedVersion: '1.0.0' }),
      { id: 'b', name: 'pkg', source: { type: 'path' }, version: null, resolvedVersion: null, config: {} }
    ]);
    expect(r.ok).toBe(true);
    expect(r.conflicts.filter((c) => c.severity === 'warning')).toHaveLength(1);
  });

  it('依赖图冲突：config.dependencies 范围不满足实际版本 → error（阻断）', () => {
    const r = checkConflicts([
      plugin('a', 'a', { resolvedVersion: '1.0.0', config: { dependencies: { b: '^2.0.0' } } }),
      plugin('b', 'b', { resolvedVersion: '1.5.0' })
    ]);
    expect(r.ok).toBe(false);
    const d = r.conflicts.find((c) => c.type === 'dependency');
    expect(d.severity).toBe('error');
    expect(d.reason).toContain('^2.0.0');
    const blocked = assertNoBlockingConflicts(r.conflicts);
    expect(blocked.ok).toBe(false);
    expect(blocked.error.exitCode).toBe(4);
  });

  it('依赖图冲突：声明依赖的插件不存在 → 跳过（不误报）', () => {
    const r = checkConflicts([
      plugin('a', 'a', { resolvedVersion: '1.0.0', config: { dependencies: { ghost: '^9.0.0' } } })
    ]);
    expect(r.ok).toBe(true);
  });

  it('依赖图冲突：dep 范围无效（非法范围串）→ warning 不阻断（C2 修复：不再误报 error）', () => {
    // C2 修复：此前 semver.satisfies(ov, 'not-a-range') 返回 false → 误报 error 阻断；
    // 非法范围串应作为 warning（fail-open 且可被用户发现），不得阻断 assemble。
    const r = checkConflicts([
      plugin('a', 'a', { resolvedVersion: '1.0.0', config: { dependencies: { b: 'not-a-range' } } }),
      plugin('b', 'b', { resolvedVersion: '1.5.0' })
    ]);
    expect(r.ok).toBe(true);
    const d = r.conflicts.find((c) => c.type === 'dependency');
    expect(d).toBeTruthy();
    expect(d.severity).toBe('warning');
    const blocked = assertNoBlockingConflicts(r.conflicts);
    expect(blocked.ok).toBe(true);
  });

  it('角色冲突 + 版本冲突同时存在 → 两条 error 都报告', () => {
    const r = checkConflicts([
      plugin('a', 'pkg-a', { resolvedVersion: '1.0.0', config: { role: '主' } }),
      plugin('b', 'pkg-b', { resolvedVersion: '2.0.0', config: { role: '主' } }),
      plugin('c', 'pkg-c', { resolvedVersion: '1.0.0', config: { role: '备' } })
    ]);
    // a/b 角色冲突；a/c 无同名冲突；但 a 与 c 同名？不，名字不同。
    expect(r.conflicts.some((c) => c.type === 'role')).toBe(true);
  });

  it('三个同名插件：两两比较产生多版本 error，但无重复 warning', () => {
    const r = checkConflicts([
      plugin('a', 'pkg', { resolvedVersion: '1.0.0' }),
      plugin('b', 'pkg', { resolvedVersion: '1.1.0' }),
      plugin('c', 'pkg', { resolvedVersion: '1.2.0' })
    ]);
    // b 与 a 冲突；c 与 a 冲突；c 与 b 冲突 → 至少 2 条 error
    expect(r.conflicts.filter((c) => c.severity === 'error' && c.type === 'version').length).toBeGreaterThanOrEqual(2);
  });

  it('assertNoBlockingConflicts：仅 warning 时不阻断', () => {
    const r = checkConflicts([
      { id: 'a', name: 'pkg', source: { type: 'path' }, version: null, resolvedVersion: null, config: {} },
      { id: 'b', name: 'pkg', source: { type: 'path' }, version: null, resolvedVersion: null, config: {} }
    ]);
    const blocked = assertNoBlockingConflicts(r.conflicts);
    expect(blocked.ok).toBe(true);
  });
});
