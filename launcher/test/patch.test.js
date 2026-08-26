'use strict';
// test/patch.test.js — cordis.patch.yml 合法性（A/N10 回归）
const YAML = require('yaml');
const {
  serializePatch,
  parsePatchYaml,
  buildPatchDocument,
  patchIdFor
} = require('../domain/patch');

const pack = {
  hotpack: '1.0',
  id: 'example',
  name: '示例科研启动组合',
  version: '1.0.0',
  plugins: [
    { id: 'lit', name: '@dsh-community/dsh-tool-literature', version: '1.2.3', source: { type: 'npm' }, config: { role: '文献检索' } },
    { id: 'web', name: 'dsh-web-search-exa', version: '0.4.2', source: { type: 'npm' }, config: {} }
  ]
};

describe('domain/patch YAML 生成（审计 A 回归）', () => {
  it('serializePatch 产物可被 yaml.parse 解析', () => {
    const r = serializePatch(pack);
    expect(r.ok).toBe(true);
    const parsed = YAML.parse(r.yamlText);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].insert).toHaveLength(2);
    expect(parsed[0].insert[0].id).toBe(patchIdFor('example', 'lit'));
    expect(parsed[0].insert[0].name).toBe('@dsh-community/dsh-tool-literature');
    expect(parsed[0].insert[0].config.role).toBe('文献检索');
    expect(parsed[0].insert[1].config).toEqual({});
  });

  it('round-trip：parsePatchYaml 校验通过', () => {
    const r = serializePatch(pack);
    const back = parsePatchYaml(r.yamlText);
    expect(back.ok).toBe(true);
    expect(back.doc[0].insert[1].id).toBe(patchIdFor('example', 'web'));
  });

  it('buildPatchDocument 与 DSH 契约结构一致（顶层序列 + insert）', () => {
    const b = buildPatchDocument(pack);
    expect(b.ok).toBe(true);
    expect(b.doc[0].insert[0]).toEqual({ id: patchIdFor('example', 'lit'), name: '@dsh-community/dsh-tool-literature', config: { role: '文献检索' } });
  });

  it('超长插件 id 清洗后仍 ≤64 且可解析（N10 回归）', () => {
    const longId = 'x'.repeat(80);
    const longPack = { ...pack, plugins: [{ id: longId, name: 'pkg-long', version: '1.0.0', source: { type: 'npm' }, config: {} }] };
    const r = serializePatch(longPack);
    expect(r.ok).toBe(true);
    expect(patchIdFor('example', longId).length).toBeLessThanOrEqual(64);
    const parsed = YAML.parse(r.yamlText);
    expect(parsed[0].insert[0].id.length).toBeLessThanOrEqual(64);
  });

  it('非法文档（缺 config）被 validate 拒绝', () => {
    const bad = [{ insert: [{ id: 'hp-x', name: 'x' }] }];
    const { validatePatchDocument } = require('../domain/patch');
    expect(validatePatchDocument(bad).ok).toBe(false);
  });
});
