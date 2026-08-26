'use strict';
// test/qa4-manifest.test.js — QA4：domain/manifest 直接单测（此前仅间接覆盖）
// 覆盖 versionSpec 全分支（防 ^^1.0.0 / ^latest 非法 spec）与
// buildManifest 三源依赖形态 / bundles 契约 / name 注入防护（N42）。
const { buildManifest, versionSpec } = require('../domain/manifest');

describe('QA4 manifest.versionSpec（npm 依赖版本 spec 防护）', () => {
  it('精确版本 → ^ 前缀兼容范围', () => {
    expect(versionSpec('1.2.3')).toBe('^1.2.3');
    expect(versionSpec('0.0.1')).toBe('^0.0.1');
    expect(versionSpec('1.2.3-beta.1')).toBe('^1.2.3-beta.1');
  });

  it('已是范围 → 原样保留', () => {
    expect(versionSpec('^1.0.0')).toBe('^1.0.0');
    expect(versionSpec('>=1.0.0')).toBe('>=1.0.0');
    expect(versionSpec('1.x')).toBe('1.x');
    expect(versionSpec('~2.3.0')).toBe('~2.3.0');
  });

  it('已知 tag → 原样', () => {
    expect(versionSpec('latest')).toBe('latest');
    expect(versionSpec('next')).toBe('next');
    expect(versionSpec('beta')).toBe('beta');
    expect(versionSpec('alpha')).toBe('alpha');
    expect(versionSpec('rc')).toBe('rc');
  });

  it('非法串/空/undefined/null → latest 兜底（杜绝 ^garbage / ^latest 形态）', () => {
    expect(versionSpec('garbage')).toBe('latest');
    expect(versionSpec('^^1.0.0')).toBe('latest');
    expect(versionSpec('^latest')).toBe('latest');
    expect(versionSpec('')).toBe('latest');
    expect(versionSpec(undefined)).toBe('latest');
    expect(versionSpec(null)).toBe('latest');
  });
});

describe('QA4 buildManifest（三源依赖形态）', () => {
  it('npm 源进 dependencies 带 ^ 前缀；path 源 link:；github 源 link:./node_modules/<name>', () => {
    const pack = { id: 'demo', plugins: [] };
    const plugins = [
      { id: 'a', name: 'pkg-a', source: { type: 'npm' }, version: '1.2.3', resolvedVersion: '1.2.3', pinned: true, installPath: null, ref: null, config: {} },
      { id: 'b', name: 'pkg-b', source: { type: 'path', path: 'C:/src/pkg-b' }, version: null, resolvedVersion: null, pinned: false, installPath: 'C:/src/pkg-b', ref: null, config: {} },
      { id: 'c', name: 'pkg-c', source: { type: 'github', repo: 'o/r', ref: 'main' }, version: null, resolvedVersion: 'main', pinned: false, installPath: null, ref: 'main', config: {} }
    ];
    const m = buildManifest(pack, plugins);
    expect(m.dependencies['pkg-a']).toBe('^1.2.3');
    expect(m.dependencies['pkg-b']).toBe('link:C:/src/pkg-b');
    // github 源指向安装器实际落地位置（C3：不再指向未被填充的 storeRoot/<name>@<ref>）
    expect(m.dependencies['pkg-c']).toBe('link:./node_modules/pkg-c');
  });

  it('bundles 只含 dsh.bundle.patch===true 且去重', () => {
    const pack = { id: 'demo', plugins: [] };
    const plugins = [
      { id: 'a', name: 'pkg-a', source: { type: 'npm' }, version: '1.0.0', resolvedVersion: '1.0.0', config: { 'dsh.bundle.patch': true } },
      { id: 'b', name: 'pkg-b', source: { type: 'npm' }, version: '1.0.0', resolvedVersion: '1.0.0', config: { 'dsh.bundle.patch': false } },
      { id: 'c', name: 'pkg-c', source: { type: 'npm' }, version: '1.0.0', resolvedVersion: '1.0.0', config: { 'dsh.bundle.patch': true } },
      { id: 'd', name: 'pkg-d', source: { type: 'npm' }, version: '1.0.0', resolvedVersion: '1.0.0', config: {} }
    ];
    const m = buildManifest(pack, plugins);
    expect(m.dsh.profile.bundles).toEqual(['pkg-a', 'pkg-c']);
    expect(m.dsh.profile.bundles).toHaveLength(2);
  });

  it('manifest.name 由 pack.id 派生（N42：杜绝 ../ 注入进包名）', () => {
    const m = buildManifest({ id: 'demo', plugins: [] }, []);
    expect(m.name).toBe('dsh-launcher-demo');
    expect(m.private).toBe(true);
    expect(m.version).toBe('0.1.0');
    expect(m.dsh).toEqual({ profile: { bundles: [] } });
  });

  it('npm 源无 resolvedVersion 时回落 version；双缺失 → latest', () => {
    const pack = { id: 'demo', plugins: [] };
    const plugins = [
      { id: 'a', name: 'pkg-a', source: { type: 'npm' }, version: '3.0.0', resolvedVersion: null, pinned: false, config: {} },
      { id: 'b', name: 'pkg-b', source: { type: 'npm' }, version: null, resolvedVersion: null, pinned: false, config: {} }
    ];
    const m = buildManifest(pack, plugins);
    expect(m.dependencies['pkg-a']).toBe('^3.0.0');
    expect(m.dependencies['pkg-b']).toBe('latest');
  });
});
