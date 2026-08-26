'use strict';
// test/ids.test.js — id / 版本 / 包名 / 源字段校验（含 semver 等价模糊对比）
// （globals: true——describe/it/expect 由 vitest 注入，无需 import）
const semver = require('semver');
const {
  validateId,
  validatePluginId,
  validatePluginName,
  validateVersion,
  validateSourcePath,
  validateSourceRepo,
  validateSourceRef,
  normalizeAndAssert,
  isValidSemverString,
  TRAVERSAL_VECTORS,
  PACK_ID_RE,
  PLUGIN_NAME_RE,
  EXACT_VERSION_RE
} = require('../ids');
const path = require('path');
const os = require('os');
const fs = require('fs');

describe('validateId', () => {
  it('接受合法 id', () => {
    for (const id of ['abc', 'my-pack', 'pack.one', 'A1_b-c.d', 'x'.repeat(64)]) {
      expect(validateId(id).ok, id).toBe(true);
    }
  });
  it('拒绝非法 id', () => {
    for (const id of ['', '-abc', '.abc', '_abc', 'abc ', 'abc.', 'a/b', 'a\\b', 'a b', 'x'.repeat(65), 123, null, undefined, 'CON', 'con', 'NUL.txt', 'COM1', 'a\u0000b', 'a\u0085b']) {
      const r = validateId(id);
      expect(r.ok, JSON.stringify(id)).toBe(false);
      expect(r.error.code).toBe('ERR_ARG_INVALID_ID');
    }
  });
  it('拒绝 14 向量穿越矩阵', () => {
    for (const v of TRAVERSAL_VECTORS) {
      expect(validateId(v).ok, v).toBe(false);
    }
  });
});

describe('validatePluginId', () => {
  it('接受合法插件 id', () => {
    for (const id of ['p', 'my-plugin', 'a1_b-c', 'A'.repeat(41)]) {
      expect(validatePluginId(id).ok, id).toBe(true);
    }
  });
  it('拒绝非法插件 id（注：CON 等保留名由插件 name / patch id 通道拒绝，插件 id 保持历史语义）', () => {
    for (const id of ['', 'a/b', 'a.b', 'x'.repeat(42), 1]) {
      expect(validatePluginId(id).ok, JSON.stringify(id)).toBe(false);
    }
  });
});

describe('validatePluginName', () => {
  it('接受合法 npm 包名（含 scoped）', () => {
    for (const name of ['pkg', '@scope/pkg', '@a/b-c.d', 'a'.repeat(100)]) {
      expect(validatePluginName(name).ok, name).toBe(true);
    }
  });
  it('拒绝非法包名与 Windows 保留名', () => {
    for (const name of ['', 'CON', 'nul', 'COM1', 'a b', 'a/b/c', '@scope/', ' pkg', 'pkg ', 'pkg.', 'a\u0000b']) {
      const r = validatePluginName(name);
      expect(r.ok, JSON.stringify(name)).toBe(false);
      expect(r.error.code).toBe('ERR_ASSEMBLY_FIELD');
    }
  });
});

describe('validateVersion（regex + 严格 semver 双检）', () => {
  it('接受精确版本', () => {
    for (const v of ['1.0.0', '1.2.3-beta.1', '1.2.3-rc.1+build.5', '0.0.1', '10.20.30']) {
      expect(validateVersion(v).ok, v).toBe(true);
    }
  });
  it('拒绝 semver 非法串（含单正则放行的）', () => {
    for (const v of ['1.02.3', '1.2.3-a..b', '1.2.3-', '1.2.3+', 'v1.0.0', '1.0', '1', 'latest', '^1.0.0', '1.0.0-01', '1.0.0-β', 123, null]) {
      const r = validateVersion(v);
      expect(r.ok, JSON.stringify(v)).toBe(false);
      expect(r.error.code).toBe('ERR_ASSEMBLY_FIELD');
    }
  });
  it('isValidSemverString 与 semver.valid 模糊等价', () => {
    const corpus = ['1.0.0', '0.0.1', '1.2.3-alpha', '1.2.3-alpha.1', '1.2.3-0.3.7', '1.2.3-x.7.z.92',
      '1.2.3+build', '1.2.3+build.11.e0f985a', '1.2.3-alpha+build', '01.2.3', '1.02.3', '1.2.03',
      '1.2.3-', '1.2.3+', '1.2.3-a..b', '1.2.3-a.', '.1.2.3', '1..3', '1.2', '1', '', 'v1.0.0',
      '1.0.0-01.2', '1.0.0-0', '1.0.0-00', '1.0.0-α', '1.0.0-a b', ' 1.0.0', '1.0.0 ',
      '999.999.999', '1.0.0-rc.1+build.1.2.3', '1.0.0+meta-valid', '1.0.0+meta..valid'];
    for (const v of corpus) {
      expect(isValidSemverString(v), JSON.stringify(v)).toBe(semver.valid(v) !== null);
    }
    // 随机扰动模糊（确定性种子）
    let seed = 42;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-+_ v';
    for (let i = 0; i < 3000; i += 1) {
      let s = '';
      const len = 1 + Math.floor(rand() * 20);
      for (let j = 0; j < len; j += 1) s += chars[Math.floor(rand() * chars.length)];
      expect(isValidSemverString(s), JSON.stringify(s)).toBe(semver.valid(s) !== null);
    }
  });

  it('数值段超 Number.MAX_SAFE_INTEGER 与 semver.valid 同判（根治：大数版本曾被放行）', () => {
    const MAX = '9007199254740991'; // 2^53-1
    const OVER = '9007199254740992'; // 2^53
    const cases = [
      [`${MAX}.1.2`, true],
      [`${OVER}.1.2`, false], // major 超界
      [`1.${OVER}.2`, false], // minor 超界
      [`1.2.${OVER}`, false], // patch 超界
      ['1.2.3-' + OVER, true], // prerelease 数值标识符不受 MAX_SAFE_INTEGER 限制
      ['1.2.3-' + MAX, true],
      ['1.2.3-01', false], // prerelease 前导零拒绝
    ];
    for (const [v, expected] of cases) {
      expect(isValidSemverString(v), JSON.stringify(v)).toBe(semver.valid(v) !== null);
      expect(isValidSemverString(v), JSON.stringify(v)).toBe(expected);
      expect(validateVersion(v).ok, JSON.stringify(v)).toBe(expected);
    }
  });
});

describe('validateSourcePath', () => {
  it('接受绝对路径', () => {
    for (const p of [path.join('C:', 'x', 'y'), path.join(os.tmpdir(), 'a', 'b'), '/abs/path', 'C:/x/y', 'C:\\x\\y']) {
      const r = validateSourcePath(p);
      if (!r.ok) console.log('rejected:', JSON.stringify(p), r.error.message);
      expect(r.ok, JSON.stringify(p)).toBe(true);
    }
  });
  it('拒绝相对/UNC/穿越/控制字符（注：/etc 等 POSIX 绝对路径为合法绝对形态，沙箱边界由 isWithin 把关）', () => {
    for (const p of ['', 'rel/path', '../x', 'a/../../x', '\\\\server\\share', '//x', 'C:/x/../y', 'C:\\x\\.', 'C:\\CON', 'C:\\x\\y ', 'C:\\x\u0000y', 123, null]) {
      const r = validateSourcePath(p);
      expect(r.ok, JSON.stringify(p)).toBe(false);
    }
    // 绝对路径合法形态
    for (const p of ['/etc', 'C:/x/y', path.join(os.tmpdir(), 'a')]) {
      expect(validateSourcePath(p).ok, JSON.stringify(p)).toBe(true);
    }
  });

  it('拒绝 ADS/Windows 非法文件名字符（根治：盘符首段放行、其余段拒绝 : * ? " < > |）', () => {
    for (const p of ['C:\\Users\\ads.txt:stream', 'C:\\Users\\foo:bar', 'C:\\a\\b*', 'C:\\a\\b?', 'C:\\a\\b|', 'C:\\a\\b<c', 'C:\\a\\b>c', 'C:\\a\\b"c']) {
      const r = validateSourcePath(p);
      expect(r.ok, JSON.stringify(p)).toBe(false);
    }
    // 盘符首段仍放行（Windows 绝对路径合法形态）
    expect(validateSourcePath('C:\\x\\y').ok).toBe(true);
    expect(validateSourcePath('C:/x/y').ok).toBe(true);
  });
});

describe('validateSourceRepo / validateSourceRef', () => {
  it('repo 基本校验', () => {
    expect(validateSourceRepo('owner/repo').ok).toBe(true);
    expect(validateSourceRepo('owner/repo.sub-1').ok).toBe(true);
    expect(validateSourceRepo('').ok).toBe(false);
    expect(validateSourceRepo('x'.repeat(513)).ok).toBe(false);
    expect(validateSourceRepo('a\u0000b').ok).toBe(false);
  });
  it('repo 必须是 owner/repo 格式（审计修复：拒绝穿越/空白/元字符/前导点）', () => {
    expect(validateSourceRepo('../../etc/passwd').ok).toBe(false);
    expect(validateSourceRepo('a/../b').ok).toBe(false);
    expect(validateSourceRepo('a/..').ok).toBe(false);
    expect(validateSourceRepo('.owner/repo').ok).toBe(false);
    expect(validateSourceRepo('owner/.repo').ok).toBe(false);
    expect(validateSourceRepo('a b/c').ok).toBe(false);
    expect(validateSourceRepo('owner/repo?query').ok).toBe(false);
    expect(validateSourceRepo('owner').ok).toBe(false); // 缺 /
    expect(validateSourceRepo('a/b/c').ok).toBe(false); // 多段
    expect(validateSourceRepo('owner/repo&x').ok).toBe(false);
  });
  it('ref 拒绝 .. / 纯点 / 空段 / 控制字符 / 超长；H-10 允许合法 /', () => {
    expect(validateSourceRef('main').ok).toBe(true);
    expect(validateSourceRef('v1.0.0').ok).toBe(true);
    expect(validateSourceRef('feature/x').ok).toBe(true); // H-10：合法 / 通过
    expect(validateSourceRef('release/v1.0/stable').ok).toBe(true);
    expect(validateSourceRef('..').ok).toBe(false);
    expect(validateSourceRef('...').ok).toBe(false);
    expect(validateSourceRef('a..b').ok).toBe(false);
    expect(validateSourceRef('a/b/../c').ok).toBe(false);
    expect(validateSourceRef('feature/').ok).toBe(false); // 尾斜杠空段
    expect(validateSourceRef('/feature').ok).toBe(false); // 首斜杠空段
    expect(validateSourceRef('a//b').ok).toBe(false);
    expect(validateSourceRef('a\\b').ok).toBe(false); // 反斜杠（shell 元字符）
    expect(validateSourceRef('a b').ok).toBe(false);
    expect(validateSourceRef('a&b').ok).toBe(false);
    expect(validateSourceRef('x'.repeat(257)).ok).toBe(false);
    expect(validateSourceRef('a\u0000b').ok).toBe(false);
    expect(validateSourceRef('').ok).toBe(false);
  });
});

describe('normalizeAndAssert', () => {
  it('合法 id 通过；穿越 id 拒绝', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-ids-'));
    expect(normalizeAndAssert('ok-id', root).ok).toBe(true);
    expect(normalizeAndAssert('..', root).ok).toBe(false);
    expect(normalizeAndAssert('../x', root).ok).toBe(false);
    expect(normalizeAndAssert('CON', root).ok).toBe(false);
  });
});

describe('正则常量', () => {
  it('PACK_ID_RE / PLUGIN_NAME_RE / EXACT_VERSION_RE 与 launcher 逐字一致', () => {
    expect(PACK_ID_RE.source).toBe('^[a-z0-9][a-z0-9._-]{0,63}$');
    expect(PLUGIN_NAME_RE.source).toBe('^(?:@[a-z0-9][a-z0-9._-]*\\/)?[a-z0-9][a-z0-9._-]*$');
    expect(EXACT_VERSION_RE.source).toBe('^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$');
    expect(PACK_ID_RE.test('MyPack')).toBe(true);
  });
});
