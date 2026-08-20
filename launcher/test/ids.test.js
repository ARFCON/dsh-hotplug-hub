'use strict';
// test/ids.test.js — 穿越矩阵（14 向量全拒）+ isWithin 防护
const path = require('path');
const {
  validateId,
  isWithin,
  normalizeAndAssert,
  TRAVERSAL_VECTORS
} = require('../domain/ids');

describe('domain/ids 穿越防护（D/N30/N31/N32/N43 回归）', () => {
  it('14 向量穿越矩阵全部拒绝', () => {
    for (const v of TRAVERSAL_VECTORS) {
      const r = validateId(v);
      expect(r.ok, `应拒绝向量: ${JSON.stringify(v)}`).toBe(false);
    }
  });

  it('合法 id 通过', () => {
    for (const id of ['example', 'pkg-a.b_c', 'x', 'A1_b-c.d']) {
      expect(validateId(id).ok, `应接受 id: ${id}`).toBe(true);
    }
  });

  it('Windows 保留设备名拒绝', () => {
    for (const bad of ['CON', 'NUL', 'COM1', 'LPT9', 'con.txt']) {
      expect(validateId(bad).ok, `应拒绝保留设备名: ${bad}`).toBe(false);
    }
  });

  it('空 / 超长 / 控制字符 / 尾部点拒绝', () => {
    expect(validateId('').ok).toBe(false);
    expect(validateId('a'.repeat(65)).ok).toBe(false);
    expect(validateId('a\u0000b').ok).toBe(false);
    expect(validateId('abc.').ok).toBe(false);
    expect(validateId('abc ').ok).toBe(false);
  });

  it('isWithin 正确判定根内/根外', () => {
    const root = path.resolve('/data/root');
    expect(isWithin(root, path.join(root, 'a'))).toBe(true);
    expect(isWithin(root, path.join(root, 'a', 'b'))).toBe(true);
    expect(isWithin(root, path.resolve(root, '..', 'escape'))).toBe(false);
    expect(isWithin(root, path.resolve('/data/other'))).toBe(false);
    expect(isWithin(root, root)).toBe(true);
  });

  it('normalizeAndAssert 对穿越 id 返回 ERR_ARG_* 错误', () => {
    const root = path.resolve('/data/root');
    const r = normalizeAndAssert('../escape', root);
    expect(r.ok).toBe(false);
    expect(r.error.code.startsWith('ERR_ARG_')).toBe(true);
  });
});
