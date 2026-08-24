'use strict';
// test/audit-patch.test.js — profile/patch.js stripUndefined 两处修复的回归测试
//   Bug C（已修）：config 含 '__proto__' 键时显式拒绝（ERR_YAML_SERIALIZE），不再静默丢键。
//   Bug D（已修）：Date/RegExp/Map/Set 等非纯对象值显式拒绝，不再静默清空为 {}。
const { serializePatch } = require('../profile/patch');

function samplePack(config) {
  return {
    hotpack: '1.0',
    id: 'pack.research',
    name: 'Research Pack',
    version: '1.0.0',
    description: 'd',
    tags: ['t'],
    plugins: [
      { id: 'lit', name: 'dsh-tool', source: { type: 'npm' }, version: '1.2.3', config }
    ]
  };
}

describe('Bug C：__proto__ 配置键显式拒绝（不再静默丢键）', () => {
  it('__proto__ 为原始值 → serializePatch 拒绝（ERR_YAML_SERIALIZE）', () => {
    const pack = samplePack(JSON.parse('{"__proto__":"pollute-me","normal":1}'));
    const r = serializePatch(pack);
    expect(r.ok).toBe(false);
    expect(r.error && r.error.message).toContain('__proto__');
  });

  it('__proto__ 为对象值 → 同样显式拒绝', () => {
    const pack = samplePack(JSON.parse('{"__proto__":{"polluted":true},"normal":2}'));
    const r = serializePatch(pack);
    expect(r.ok).toBe(false);
    expect(r.error && r.error.message).toContain('__proto__');
  });

  it('普通键 constructor / prototype 正常往返；仅 __proto__ 被显式拒绝', () => {
    const ok = samplePack({ constructor: 'c', prototype: 'p' });
    const r = serializePatch(ok);
    expect(r.ok).toBe(true);
    const cfg = r.doc[0].insert[0].config;
    expect(cfg.constructor).toBe('c');
    expect(cfg.prototype).toBe('p');
    // __proto__ 单独出现即拒绝
    const bad = serializePatch(samplePack(JSON.parse('{"__proto__":1}')));
    expect(bad.ok).toBe(false);
    expect(bad.error && bad.error.message).toContain('__proto__');
  });
});

describe('Bug D：非纯对象值显式拒绝（不再静默清空为 {}）', () => {
  it('Date / RegExp / Map / Set 等非纯对象值 → serializePatch 拒绝', () => {
    for (const bad of [new Date('2020-01-01T00:00:00.000Z'), /ab+c/gi, new Map([['a', 1], ['b', 2]]), new Set([1, 2, 3])]) {
      const r = serializePatch(samplePack({ bad }));
      expect(r.ok).toBe(false);
      expect(r.error && r.error.message).toContain('非纯对象');
    }
  });

  it('纯对象 + 数组 + 基本类型 config 仍正常序列化（不误伤）', () => {
    const r = serializePatch(samplePack({ arr: [1, 2, 3], nested: { a: { b: 'x' } }, n: 1, s: 'str', b: true }));
    expect(r.ok).toBe(true);
    const cfg = r.doc[0].insert[0].config;
    expect(cfg.arr).toEqual([1, 2, 3]);
    expect(cfg.nested).toEqual({ a: { b: 'x' } });
  });
});
