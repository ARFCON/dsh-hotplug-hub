'use strict';
// test/resolve.test.js — 依赖解析 + semver pin（B/G 回归）
const { resolvePlugins, resolveVersion } = require('../domain/resolve');

const pack = {
  hotpack: '1.0',
  id: 'example',
  name: '示例',
  version: '1.0.0',
  plugins: [
    { id: 'a', name: 'pkg-a', version: '1.2.3', source: { type: 'npm' }, config: {} },
    { id: 'b', name: 'pkg-b', source: { type: 'path', path: 'C:/src/b' }, config: {} },
    { id: 'c', name: 'pkg-c', source: { type: 'github', repo: 'org/c', ref: 'v2' }, config: {} }
  ]
};

describe('domain/resolve 依赖解析 + semver pin（审计 B 回归）', () => {
  it('npm 精确版直接 pin；path/github 各就其位', () => {
    const r = resolvePlugins(pack, { availableVersions: () => [] });
    expect(r.ok).toBe(true);
    const [a, b, c] = r.resolved.plugins;
    expect(a.resolvedVersion).toBe('1.2.3');
    expect(a.pinned).toBe(true);
    expect(b.installPath).toBe('C:/src/b');
    expect(c.ref).toBe('v2');
  });

  it('registry 注入后范围版选最高满足（semver.maxSatisfying）', () => {
    const registry = { availableVersions: (name) => (name === 'pkg-a' ? ['1.2.0', '1.2.3', '2.0.0'] : []) };
    const rangePack = {
      ...pack,
      plugins: [{ id: 'a', name: 'pkg-a', version: '^1.2.0', source: { type: 'npm' }, config: {} }]
    };
    const r = resolvePlugins(rangePack, registry);
    expect(r.ok).toBe(true);
    expect(r.resolved.plugins[0].resolvedVersion).toBe('1.2.3');
    expect(r.resolved.plugins[0].pinned).toBe(true);
  });

  it('无 registry 数据且为范围版 → warning（不失败、不漏报）', () => {
    const r = resolveVersion('pkg-a', '^1.0.0', { availableVersions: () => [] });
    expect(r.pinned).toBe(false);
    expect(r.warning).toBeTruthy();
  });

  it('registry 无满足版本 → ERR_INSTALL_ACQUIRE', () => {
    const r = resolveVersion('pkg-a', '^9.0.0', { availableVersions: () => ['1.0.0'] });
    expect(r.error).toBeTruthy();
    expect(r.error.code).toBe('ERR_INSTALL_ACQUIRE');
  });
});
