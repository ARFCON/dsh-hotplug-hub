'use strict';
// test/assembly.test.js — hotpack 1.0 校验（K/N7/N21/N22/N35 回归）
const { parseHotpack, validateAssembly, parseLegacy } = require('../domain/assembly');

const valid = {
  hotpack: '1.0',
  id: 'example',
  name: '示例组合',
  version: '1.0.0',
  plugins: [
    { id: 'a', name: 'pkg-a', version: '1.2.3', source: { type: 'npm' }, config: {} },
    { id: 'b', name: 'pkg-b', source: { type: 'path', path: 'C:/src/b' }, config: {} },
    { id: 'c', name: 'pkg-c', source: { type: 'github', repo: 'org/repo', ref: 'main' }, config: {} }
  ]
};

describe('domain/assembly hotpack 1.0 校验', () => {
  it('合法 assembly 通过并归一化', () => {
    const r = parseHotpack(valid);
    expect(r.ok).toBe(true);
    expect(r.pack.plugins).toHaveLength(3);
    expect(r.pack.tags).toEqual([]);
    expect(r.pack.description).toBe('');
  });

  it('重复插件 id 拒绝（K 回归）', () => {
    const dup = { ...valid, plugins: [valid.plugins[0], { ...valid.plugins[0] }] };
    const r = parseHotpack(dup);
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_ASSEMBLY_DUPLICATE');
  });

  it('插件 id 大小写不敏感重复拒绝（N14 回归：abc vs ABC）', () => {
    const dup = {
      ...valid,
      plugins: [
        { id: 'abc', name: 'pkg-a', version: '1.2.3', source: { type: 'npm' }, config: {} },
        { id: 'ABC', name: 'pkg-b', version: '1.2.3', source: { type: 'npm' }, config: {} }
      ]
    };
    const r = parseHotpack(dup);
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_ASSEMBLY_DUPLICATE');
  });

  it('不支持 hotpack 版本拒绝', () => {
    const r = parseHotpack({ ...valid, hotpack: '0.9' });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_ASSEMBLY_UNSUPPORTED');
  });

  it('非法 JSON 字符串 → ERR_ASSEMBLY_INVALID_JSON（N7 区分缺失/损坏）', () => {
    const r = parseHotpack('{not json');
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_ASSEMBLY_INVALID_JSON');
  });

  it('空 plugins 拒绝（N21 回归）', () => {
    const r = parseHotpack({ ...valid, plugins: [] });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_ASSEMBLY_FIELD');
  });

  it('未知 source.type 拒绝（N22 回归）', () => {
    const r = parseHotpack({
      ...valid,
      plugins: [{ id: 'd', name: 'pkg-d', source: { type: 'docker' }, config: {} }]
    });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_ASSEMBLY_FIELD');
  });

  it('npm 源必须给精确 version', () => {
    const r = parseHotpack({
      ...valid,
      plugins: [{ id: 'd', name: 'pkg-d', source: { type: 'npm' }, config: {} }]
    });
    expect(r.ok).toBe(false);
  });

  it('N35：UNC source.path 拒绝', () => {
    const r = parseHotpack({
      ...valid,
      plugins: [{ id: 'd', name: 'pkg-d', source: { type: 'path', path: '//attacker-host/share' }, config: {} }]
    });
    expect(r.ok).toBe(false);
  });

  it('N35：控制字符 source.repo 拒绝', () => {
    const r = parseHotpack({
      ...valid,
      plugins: [{ id: 'd', name: 'pkg-d', source: { type: 'github', repo: 'org/repo\u0000x' }, config: {} }]
    });
    expect(r.ok).toBe(false);
  });

  it('validateAssembly 别名：成功/失败与 parseHotpack 语义一致', () => {
    const ok = validateAssembly(valid);
    expect(ok.ok).toBe(true);
    expect(ok.pack.plugins).toHaveLength(3);
    const bad = validateAssembly({ ...valid, hotpack: '9.9' });
    expect(bad.ok).toBe(false);
    expect(bad.error.code).toBe('ERR_ASSEMBLY_UNSUPPORTED');
  });

  it('parseLegacy：{packId, bundles} 形态兼容解析（成功/失败）', () => {
    const raw = {
      packId: 'legacy-pack',
      name: '遗留组合',
      version: '1.0.0',
      bundles: [
        { id: 'a', name: 'pkg-a', version: '1.0.0', source: { type: 'npm' }, config: {} }
      ]
    };
    const ok = parseLegacy(raw);
    expect(ok.ok).toBe(true);
    expect(ok.pack.id).toBe('legacy-pack');
    expect(ok.pack.plugins).toHaveLength(1);
    const bad = parseLegacy({ packId: 'x', name: 'n', version: '1.0.0', bundles: 'not-array' });
    expect(bad.ok).toBe(false);
    expect(bad.error).toBeDefined();
  });
});
