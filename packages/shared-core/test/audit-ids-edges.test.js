'use strict';
// test/audit-ids-edges.test.js — 审计：ids.js 各可疑点的逐项验证（证伪/边界确认）
// 结论摘要见文件尾注释；本文件以「当前应为安全行为」的断言固化契约，防止回归。
const semver = require('semver');
const path = require('path');
const os = require('os');
const fs = require('fs');
const {
  validateId,
  validatePluginName,
  validateVersion,
  validateSourcePath,
  validateSourceRepo,
  validateSourceRef,
  normalizeAndAssert,
  isValidSemverString
} = require('../ids');

describe('可疑点 1：PACK_ID_RE 允许 "." 是否仍杜绝路径穿越？', () => {
  it('证伪：含点的安全名（a..b / a.b）被接受，但不构成穿越（单段名，无分隔符语义）', () => {
    // 'a..b' 是单段名，path.join 不按 '.' 切分，无穿越
    for (const id of ['a..b', 'a.b', 'a.b.c']) {
      expect(validateId(id).ok, id).toBe(true);
    }
  });
  it('证伪：真正的穿越形态（.. / .a / a. / a.. / a.b..）全部被拒', () => {
    for (const id of ['..', '.a', 'a.', 'a..', 'a.b..', '.', '...']) {
      expect(validateId(id).ok, JSON.stringify(id)).toBe(false);
    }
  });
  it('normalizeAndAssert 对 a..b 兜底仍落在 root 内（path.join + assertWithin 双重兜底）', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-id-'));
    const r = normalizeAndAssert('a..b', root);
    expect(r.ok).toBe(true);
    // path.join(root, 'a..b') 必然在 root 内（无分隔符穿越）
    expect(path.relative(root, path.join(root, 'a..b'))).toBe('a..b');
    for (const bad of ['..', '../x', 'a/../b', 'a\\..\\b']) {
      expect(normalizeAndAssert(bad, root).ok, JSON.stringify(bad)).toBe(false);
    }
  });
  it('保留设备名（大小写 + 扩展名）被拒；a.CON 安全（base 是 a 非 CON）', () => {
    for (const id of ['CON', 'con', 'CON.txt', 'COM1', 'lpt9.foo']) {
      expect(validateId(id).ok, id).toBe(false);
    }
    // 'a.CON' 的 base 是 'a'，Windows 视为普通文件名，非保留设备名
    expect(validateId('a.CON').ok).toBe(true);
  });
});

describe('可疑点 2：PLUGIN_NAME_RE 允许 @scope/name，逐段 Windows 安全名检查是否漏段？', () => {
  it('证伪：scope 段始终带 @ 前缀，@con 非设备名（安全）；name 段含设备名被拒', () => {
    // @con 是独立目录名（含 @ 前缀），Windows 不会当作 CON 设备
    expect(validatePluginName('@con/pkg').ok).toBe(true);
    expect(validatePluginName('@scope/pkg').ok).toBe(true);
    // name 段（末段）含设备名 → 被 checkWindowsSafeName 拒绝
    expect(validatePluginName('@scope/CON').ok).toBe(false);
    expect(validatePluginName('@scope/con').ok).toBe(false);
    expect(validatePluginName('@scope/COM1').ok).toBe(false);
  });
  it('证伪：@CON/pkg 被拒的原因是大小写（正则无 i 标志），而非设备名——npm 包名小写契约', () => {
    expect(validatePluginName('@CON/pkg').ok).toBe(false); // 大写 scope 不匹配 PLUGIN_NAME_RE
    expect(validatePluginName('@con/pkg').ok).toBe(true); // 小写合法
  });
});

describe('可疑点 3：EXACT_VERSION_RE + isValidSemverString 双条件与 semver.valid 的等价性', () => {
  it('validateVersion 拒绝所有 semver 非法串（单正则放行的反例全部被双条件兜住）', () => {
    for (const v of ['1.02.3', '1.2.3-a..b', '01.2.3', '1.2.3+', 'v1.2.3', '1.2.3-01',
      '1.2.3-', '1.2.3+', '1.2.3-a.', '.1.2.3', '1..3', '1.0.0-00', '1.0.0-α',
      'x'.repeat(257), '1.0.0+build..x']) {
      expect(validateVersion(v).ok, JSON.stringify(v)).toBe(false);
    }
  });
  it('validateVersion 接受合法精确版本（含 prerelease/build）', () => {
    for (const v of ['1.0.0', '1.2.3-beta.1', '1.2.3-rc.1+build.5', '0.0.1', '10.20.30',
      '1.2.3-0', '1.2.3-alpha.1.2.3']) {
      expect(validateVersion(v).ok, v).toBe(true);
    }
  });
  it('证伪方向：validateVersion 绝不放行 semver 非法串（大语料模糊：accept ⇒ semver.valid 非空）', () => {
    let seed = 12345;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-+_ v';
    for (let i = 0; i < 20000; i += 1) {
      let s = '';
      const len = 1 + Math.floor(rand() * 24);
      for (let j = 0; j < len; j += 1) s += chars[Math.floor(rand() * chars.length)];
      if (validateVersion(s).ok) {
        expect(semver.valid(s) !== null, `validateVersion 放行了 semver 非法串: ${JSON.stringify(s)}`).toBe(true);
      }
    }
  });
  it('isValidSemverString 与 semver.valid 大语料等价（含 v/空白/+/-/./0）', () => {
    let seed = 7;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-+_ v';
    for (let i = 0; i < 20000; i += 1) {
      let s = '';
      const len = 1 + Math.floor(rand() * 20);
      for (let j = 0; j < len; j += 1) s += chars[Math.floor(rand() * chars.length)];
      expect(isValidSemverString(s), JSON.stringify(s)).toBe(semver.valid(s) !== null);
    }
  });
});

describe('可疑点 4：validateSourceRef 允许 "/"，边界（a//b、/a、a/、.a、a.、a..b）', () => {
  it('穿越/空段/元字符全部拒绝', () => {
    for (const r of ['a//b', '/a', 'a/', 'a..b', 'a/b/../c', 'a\\b', 'a b', 'a&b', '..', '...',
      'feature/', 'a./', 'x'.repeat(257)]) {
      expect(validateSourceRef(r).ok, JSON.stringify(r)).toBe(false);
    }
  });
  it('证伪：.a / a. / a/./b 被接受，但不构成安全逃逸（无穿越、无 shell，仅 git 命名合规性差异）', () => {
    // 单点段 '.' 与首/尾单点非穿越；进 argv（数组、shell:false）与 URL 路径段均无害
    expect(validateSourceRef('.a').ok).toBe(true);
    expect(validateSourceRef('a.').ok).toBe(true);
    expect(validateSourceRef('a/./b').ok).toBe(true);
    expect(validateSourceRef('main').ok).toBe(true);
    expect(validateSourceRef('feature/x').ok).toBe(true);
  });
});

describe('可疑点 5：validateSourcePath 绝对路径/盘符/UNC/尾斜杠/超长边界', () => {
  it('合法绝对路径被接受（盘符大小写、驱动器根、POSIX 绝对、混合分隔符）', () => {
    for (const p of ['C:\\Windows', 'C:/x', 'C:\\', 'c:/x', '/etc', 'C://x', path.join(os.tmpdir(), 'a')]) {
      expect(validateSourcePath(p).ok, JSON.stringify(p)).toBe(true);
    }
  });
  it('相对/UNC/穿越/设备名/尾点空格/控制字符/超长全部拒绝', () => {
    for (const p of ['rel/path', '..\\x', 'a/../../x', '\\\\server\\share', '//x',
      'C:/x/../y', 'C:\\x\\.', 'C:\\CON', 'C:\\x\\y ', 'C:\\x\u0000y', 'x'.repeat(4097), 123, null, '']) {
      expect(validateSourcePath(p).ok, JSON.stringify(p)).toBe(false);
    }
  });
  it('观察：单前导反斜杠根路径（\\server\\share）被接受——非 UNC，是当前盘根相对路径', () => {
    // path.isAbsolute 视 '\server\share' 为绝对（当前盘根），非网络路径；UNC 检测只拦双反斜杠
    expect(validateSourcePath('\\server\\share').ok).toBe(true);
  });
  it('观察：MAX_SOURCE_PATH_LENGTH 按字符计数（4096 字符），非字节', () => {
    // 4096 字符 ≈ 12KB UTF-8 字节（4095 个 CJK + 前导 /），仍被接受——长度预算为字符语义
    const cjk = '/' + '汉'.repeat(4095);
    expect(cjk.length).toBe(4096);
    expect(Buffer.byteLength(cjk, 'utf8')).toBeGreaterThan(4096);
    expect(validateSourcePath(cjk).ok).toBe(true);
    // 恰好超 1 字符即拒
    expect(validateSourcePath('/' + '汉'.repeat(4096)).ok).toBe(false);
  });
});

describe('可疑点 6：validateSourceRepo REPO_RE 形态边界', () => {
  it('合法 owner/repo 通过；非法形态拒绝', () => {
    expect(validateSourceRepo('owner/repo').ok).toBe(true);
    expect(validateSourceRepo('o1/r2.sub-3').ok).toBe(true);
    for (const r of ['o/r/', 'o//r', '.o/r', '-o/r', 'o/..', 'o/.r', 'o/r&x', 'owner', 'a/b/c']) {
      expect(validateSourceRepo(r).ok, JSON.stringify(r)).toBe(false);
    }
  });
  it('证伪：无路径穿越（.. 段被前导字母数字约束挡住）；o/repo.. 仅命名合规差异，非穿越', () => {
    // repo 段以字母数字开头，杜绝 '..' 作为整段；'repo..' 是单段名，URL 中无穿越语义
    expect(validateSourceRepo('a/..').ok).toBe(false);
    expect(validateSourceRepo('a/../b').ok).toBe(false);
    expect(validateSourceRepo('o/repo..').ok).toBe(true); // 观察：双点结尾被放行（非穿越）
  });
});
