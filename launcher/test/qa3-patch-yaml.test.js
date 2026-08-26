'use strict';
// test/qa3-patch-yaml.test.js — patch/YAML 安全性穷尽（QA3 第 2 层主题 2）
// 插件 name/config 含特殊字符：YAML 保留字符 / 中文 / emoji / 换行 / 制表符 / 关键字 / 数字字符串
// → yaml.parse 必须成功、round-trip 一致、golden 深比对。
const YAML = require('yaml');
const { serializePatch, buildPatchDocument, patchIdFor, parsePatchYaml, validatePatchDocument } = require('../domain/patch');

const SPECIAL_NAMES = [
  '!', '&', '*', '#', '|', '>', '%', '@', '"', "'", ':', '-', '?', '{', '}', '[', ']', ',',
  '中文名', 'emoji🎉🚀', 'a\nb', 'a\tb', 'null', 'true', 'false', '123', '1.5', 'yes', 'no',
  'a: b', 'a # comment', "'quoted'", '"double"', 'line1\nline2\nline3', '  leading space', 'trailing  ',
  'x'.repeat(1000) // 超长 name（1000 字符）
];

function makePack(id, plugins) {
  return { hotpack: '1.0', id, name: '示例组合', version: '1.0.0', plugins };
}

describe('QA3 patch/YAML 安全性（审计 A/N10/N17 强化）', () => {
  it('name 含 YAML 特殊字符：serializePatch 成功且 yaml.parse 可解析', () => {
    for (const name of SPECIAL_NAMES) {
      const pack = makePack('sp', [{ id: 'p1', name, version: '1.0.0', source: { type: 'npm' }, config: {} }]);
      const r = serializePatch(pack);
      expect(r.ok, `name=${JSON.stringify(name.slice(0, 30))}... 应序列化成功`).toBe(true);
      let parsed;
      expect(() => { parsed = YAML.parse(r.yamlText); }).not.toThrow();
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0].insert[0].name).toBe(name);
    }
  });

  it('config 含 YAML 特殊值：深层 round-trip 一致', () => {
    const config = {
      role: '搜索!&*',
      apiKeyEnv: 'A#B|C>D',
      'dsh.bundle.patch': true,
      nested: { a: '中文🎉', b: 'null', c: '123', d: 'a\nb', e: ['x', 'y', 'z'] },
      num: 42,
      zero: 0,
      bool: false,
      empty: ''
    };
    const pack = makePack('cfg', [{ id: 'p1', name: 'pkg', version: '1.0.0', source: { type: 'npm' }, config }]);
    const r = serializePatch(pack);
    expect(r.ok).toBe(true);
    const parsed = YAML.parse(r.yamlText);
    expect(parsed[0].insert[0].config).toEqual(config);
  });

  it('golden 深比对：buildPatchDocument 结构与 yaml.parse(serializePatch) 完全一致', () => {
    const pack = makePack('golden', [
      { id: 'lit', name: '@dsh-community/dsh-tool-literature', version: '1.2.3', source: { type: 'npm' }, config: { role: '文献检索', 'dsh.bundle.patch': true } },
      { id: 'web', name: 'dsh-web-search-exa', version: '0.4.2', source: { type: 'npm' }, config: {} },
      { id: 'zh', name: 'pkg-中文', version: '1.0.0', source: { type: 'npm' }, config: { emoji: '🎉' } }
    ]);
    const built = buildPatchDocument(pack);
    expect(built.ok).toBe(true);
    const r = serializePatch(pack);
    expect(r.ok).toBe(true);
    const parsed = YAML.parse(r.yamlText);
    // 深比对：序列化再解析的结构必须与构建文档逐字段一致
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(built.doc));
  });

  it('round-trip 幂等：同一 pack 两次 serializePatch 的 YAML 文本一致', () => {
    const pack = makePack('rt', [
      { id: 'a', name: 'pkg-a', version: '1.0.0', source: { type: 'npm' }, config: { k: 'v!@#' } }
    ]);
    const r1 = serializePatch(pack);
    const r2 = serializePatch(pack);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r2.yamlText).toBe(r1.yamlText);
    expect(YAML.parse(r2.yamlText)).toEqual(YAML.parse(r1.yamlText));
  });

  it('空 config / 缺失 config → config 归一为 {}', () => {
    const pack = makePack('ec', [
      { id: 'a', name: 'pkg-a', version: '1.0.0', source: { type: 'npm' } },
      { id: 'b', name: 'pkg-b', version: '1.0.0', source: { type: 'npm' }, config: null }
    ]);
    const r = serializePatch(pack);
    expect(r.ok).toBe(true);
    const parsed = YAML.parse(r.yamlText);
    expect(parsed[0].insert[0].config).toEqual({});
    expect(parsed[0].insert[1].config).toEqual({});
  });

  it('null/undefined config 值：JSON 语义（null 保留，undefined 被 YAML 丢弃）', () => {
    const pack = makePack('nul', [{ id: 'a', name: 'pkg-a', version: '1.0.0', source: { type: 'npm' }, config: { k: null, u: undefined } }]);
    const r = serializePatch(pack);
    expect(r.ok).toBe(true);
    const parsed = YAML.parse(r.yamlText);
    expect(parsed[0].insert[0].config.k).toBe(null);
    // undefined 无 JSON 表示 → 序列化时被丢弃（记录行为）
    expect('u' in parsed[0].insert[0].config).toBe(false);
  });

  it('patch id 清洗：非法字符替换 / 整串首尾连字符去除 / ≤64（内部连字符串保留为允许字符）', () => {
    expect(patchIdFor('example', 'lit')).toMatch(/^hp-example-lit-[0-9a-f]{8}$/);
    expect(patchIdFor('ExAmPle', 'LIT')).toBe(patchIdFor('example', 'lit')); // 小写化（哈希基于小写化编码）
    expect(patchIdFor('example', 'a b c')).toMatch(/^hp-example-a-b-c-[0-9a-f]{8}$/); // 空格→连字符
    // 内部连字符属于允许字符，连续连字符不折叠（记录行为）；仅整串首尾 '-' 被去除
    expect(patchIdFor('example', '---x---')).toMatch(/^hp-example----x-[0-9a-f]{8}$/);
    expect(patchIdFor('example', 'x'.repeat(80)).length).toBeLessThanOrEqual(64);
  });

  it('超长插件 id 截断到 64 后仍可解析（N10 强化）', () => {
    const longId = 'x'.repeat(80);
    const pack = makePack('long', [{ id: longId, name: 'pkg-long', version: '1.0.0', source: { type: 'npm' }, config: {} }]);
    const r = serializePatch(pack);
    expect(r.ok).toBe(true);
    const parsed = YAML.parse(r.yamlText);
    expect(parsed[0].insert[0].id.length).toBeLessThanOrEqual(64);
  });

  it('超长 name（1000 字符）round-trip 完整保留', () => {
    const longName = 'n'.repeat(1000);
    const pack = makePack('ln', [{ id: 'a', name: longName, version: '1.0.0', source: { type: 'npm' }, config: {} }]);
    const r = serializePatch(pack);
    expect(r.ok).toBe(true);
    const parsed = YAML.parse(r.yamlText);
    expect(parsed[0].insert[0].name).toBe(longName);
    expect(parsed[0].insert[0].name.length).toBe(1000);
  });

  it('validatePatchDocument：缺 id/name/config、非数组、空数组、insert 非数组均拒绝', () => {
    expect(validatePatchDocument([]).ok).toBe(false);
    // 空 insert 数组当前通过校验（无 item 可遍历）—— 记录行为（P3 观察：空 insert 不报错）
    expect(validatePatchDocument([{ insert: [] }]).ok).toBe(true);
    expect(validatePatchDocument([{ insert: [{ name: 'x', config: {} }] }]).ok).toBe(false); // 缺 id
    expect(validatePatchDocument([{ insert: [{ id: 'hp-x', config: {} }] }]).ok).toBe(false); // 缺 name
    expect(validatePatchDocument([{ insert: [{ id: 'hp-x', name: 'x' }] }]).ok).toBe(false); // 缺 config
    expect(validatePatchDocument([{ insert: 'not-array' }]).ok).toBe(false);
    expect(validatePatchDocument('not-array').ok).toBe(false);
    expect(validatePatchDocument(null).ok).toBe(false);
    expect(validatePatchDocument(undefined).ok).toBe(false);
  });

  it('parsePatchYaml 对非法 YAML 文本返回 ERR_YAML_PARSE', () => {
    const r = parsePatchYaml('a: [unclosed');
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_YAML_PARSE');
  });

  it('serializePatch 对无 plugins 的 pack 返回 ERR_YAML_INVALID', () => {
    const r = serializePatch({ hotpack: '1.0', id: 'x', name: 'x', version: '1.0.0' });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_YAML_INVALID');
  });

  it('patch id 潜在碰撞：截断后追加哈希后缀保证唯一（QA3 修复回归）', () => {
    // pack id 64 字符 + 插件 id 40 字符 → 拼接后 >64 被截断；修复前两个不同插件 id 共享 64 前缀 → 相同 patch id
    // 修复后（domain/patch.js patchIdFor）：截断时追加 8 位短哈希 → 不同源 id 不碰撞
    const packId = 'x'.repeat(64);
    const id1 = 'a'.repeat(40);
    const id2 = 'a'.repeat(39) + 'b';
    const pid1 = patchIdFor(packId, id1);
    const pid2 = patchIdFor(packId, id2);
    expect(pid1).not.toBe(pid2); // 修复：截断后不再碰撞
    expect(pid1.length).toBeLessThanOrEqual(64);
    expect(pid2.length).toBeLessThanOrEqual(64);
    const r = serializePatch({
      hotpack: '1.0', id: packId, name: 'x', version: '1.0.0',
      plugins: [
        { id: id1, name: 'pkg-a', version: '1.0.0', source: { type: 'npm' }, config: {} },
        { id: id2, name: 'pkg-b', version: '1.0.0', source: { type: 'npm' }, config: {} }
      ]
    });
    expect(r.ok).toBe(true);
    const parsed = YAML.parse(r.yamlText);
    const ids = parsed[0].insert.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length); // 修复：产物 insert id 唯一
  });
});
