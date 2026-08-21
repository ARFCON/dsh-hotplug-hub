'use strict';
// test/patch.test.js — patch id / 文档构建 / YAML 序列化回读自校验
const path = require('path');
const { patchIdFor, buildPatchDocument, serializePatch, parsePatchYaml, validatePatchDocument } = require('../profile/patch');

function samplePack() {
  return {
    hotpack: '1.0',
    id: 'pack.research',
    name: 'Research Pack',
    version: '1.0.0',
    description: 'd',
    tags: ['t'],
    plugins: [
      { id: 'lit', name: '@dsh-community/dsh-tool-literature', source: { type: 'npm' }, version: '1.2.3', config: { apiKeyEnv: 'X' } },
      { id: 'cite', name: 'dsh-cite', source: { type: 'npm' }, version: '0.9.1', config: {} }
    ]
  };
}

describe('patchIdFor（清洗 + 64 上限 + 哈希后缀）', () => {
  it('常规清洗', () => {
    expect(patchIdFor('pack.a', 'lit')).toBe('hp-pack.a-lit');
    expect(patchIdFor('PACK.B', 'LIT')).toBe('hp-pack.b-lit');
    expect(patchIdFor('pack a', 'x y')).toBe('hp-pack-a-x-y');
  });
  it('超长截断 + 哈希后缀防碰撞', () => {
    const longA = patchIdFor('x'.repeat(40), 'a'.repeat(40));
    const longB = patchIdFor('x'.repeat(40), 'b'.repeat(40));
    expect(longA.length).toBeLessThanOrEqual(64);
    expect(longB.length).toBeLessThanOrEqual(64);
    expect(longA).not.toBe(longB);
  });
});

describe('buildPatchDocument / serializePatch', () => {
  it('构建 doc 并序列化后回读语义等价（C3）', () => {
    const r = serializePatch(samplePack());
    expect(r.ok).toBe(true);
    expect(r.doc).toEqual([
      {
        insert: [
          { id: 'hp-pack.research-lit', name: '@dsh-community/dsh-tool-literature', config: { apiKeyEnv: 'X' } },
          { id: 'hp-pack.research-cite', name: 'dsh-cite', config: {} }
        ]
      }
    ]);
    expect(typeof r.yamlText).toBe('string');
    const back = parsePatchYaml(r.yamlText);
    expect(back.ok).toBe(true);
    expect(back.doc).toEqual(r.doc);
  });

  it('undefined 配置键被自校验发现（序列化失败而非静默丢键）', () => {
    const pack = samplePack();
    pack.plugins[0].config = { key: undefined };
    const r = serializePatch(pack);
    // stripUndefined 会先清洗 → 清洗后语义等价 → 序列化成功；但 doc 不含 undefined 键
    expect(r.ok).toBe(true);
    expect(r.doc[0].insert[0].config).toEqual({});
  });

  it('pack 缺 plugins → ERR_YAML_INVALID', () => {
    const r = serializePatch({ id: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_YAML_INVALID');
  });

  it('M-52：循环引用 config → ERR_YAML_SERIALIZE（不栈溢出裸抛）', () => {
    const pack = samplePack();
    const loop = { self: null };
    loop.self = loop;
    pack.plugins[0].config = { nested: loop };
    const r = serializePatch(pack);
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_YAML_SERIALIZE');
    expect(r.error.message).toContain('循环引用');
  });

  it('M-52：共享引用（非环）不误报，正常序列化', () => {
    const pack = samplePack();
    const shared = { k: 'v' };
    pack.plugins[0].config = { a: shared, b: shared };
    const r = serializePatch(pack);
    expect(r.ok).toBe(true);
    expect(r.doc[0].insert[0].config).toEqual({ a: { k: 'v' }, b: { k: 'v' } });
  });

  it('M-52：不可序列化值（Function/BigInt）→ ERR_YAML_SERIALIZE（不裸抛）', () => {
    const packFn = samplePack();
    packFn.plugins[0].config = { fn: () => 1 };
    const rFn = serializePatch(packFn);
    expect(rFn.ok).toBe(false);
    expect(rFn.error.code).toBe('ERR_YAML_SERIALIZE');

    const packBig = samplePack();
    packBig.plugins[0].config = { b: 1n };
    const rBig = serializePatch(packBig);
    expect(rBig.ok).toBe(false);
    expect(rBig.error.code).toBe('ERR_YAML_SERIALIZE');
  });
});

describe('parsePatchYaml / validatePatchDocument', () => {
  it('接受合法文档', () => {
    const r = parsePatchYaml('- insert:\n    - id: hp-a\n      name: \'pkg-a\'\n      config: {}\n');
    expect(r.ok).toBe(true);
    expect(r.doc[0].insert[0].id).toBe('hp-a');
  });
  it('拒绝：空数组 / 非数组 / 重复 id / 保留名 id / 纯空白 name / 数组 config', () => {
    expect(parsePatchYaml('[]').ok).toBe(false);
    expect(parsePatchYaml('{}').ok).toBe(false);
    expect(parsePatchYaml('- insert:\n    - id: a\n      name: \'x\'\n      config: {}\n    - id: a\n      name: \'y\'\n      config: {}\n').ok).toBe(false);
    expect(parsePatchYaml('- insert:\n    - id: CON\n      name: \'x\'\n      config: {}\n').ok).toBe(false);
    expect(parsePatchYaml('- insert:\n    - id: a\n      name: \'   \'\n      config: {}\n').ok).toBe(false);
    expect(parsePatchYaml('- insert:\n    - id: a\n      name: \'x\'\n      config: []\n').ok).toBe(false);
    expect(parsePatchYaml('not yaml [[[').ok).toBe(false);
  });
  it('validatePatchDocument 直接校验', () => {
    expect(validatePatchDocument([]).ok).toBe(false);
    // 顶层非空数组 + insert 数组（可为空——禁用态）→ 通过
    expect(validatePatchDocument([{ insert: [] }]).ok).toBe(true);
    expect(validatePatchDocument([{ insert: [{ id: 'a', name: 'x', config: {} }] }]).ok).toBe(true);
  });
});
