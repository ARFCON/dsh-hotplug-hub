'use strict';
// test/shell.test.js — 命令安全契约（H-7 / R-v5-9）：注入向量矩阵
const { CMD_SPECIAL_RE, assertShellSafe, assertShellSafeUrl, SHELL_SAFE_LIST } = require('../security/shell');

describe('CMD_SPECIAL_RE', () => {
  it('覆盖全部 shell 元字符与控制字符', () => {
    for (const ch of ['&', '|', ';', '`', '$', '(', ')', '<', '>', '"', "'", '\\', '\u0000', '\n', '\u001f', '\u007f']) {
      expect(CMD_SPECIAL_RE.test(ch), JSON.stringify(ch)).toBe(true);
    }
    for (const ch of ['a', '0', '.', '_', '-', '/', ':', '@', '=', '+', '?', '%', '#']) {
      expect(CMD_SPECIAL_RE.test(ch), JSON.stringify(ch)).toBe(false);
    }
  });
});

describe('assertShellSafe', () => {
  it('接受合法值', () => {
    for (const v of ['main', 'v1.0.0', 'my_tag', 'profile-1', 'abc.DEF_1']) {
      expect(assertShellSafe(v).ok, v).toBe(true);
    }
    // extraChars 放宽（repo 的 /）
    expect(assertShellSafe('owner/repo', 'repo', { extraChars: '/' }).ok).toBe(true);
  });

  it('拒绝注入向量', () => {
    const vectors = ['a&b', 'a|b', 'a;b', 'a`b', 'a$(id)', 'a(b)', 'a<b', 'a>b', 'a"b', "a'b", 'a\\b', 'a b', 'a\tb', 'a\nb', 'a\u0000b', '-abc', '.abc', '_abc', 'a/b', 'x'.repeat(257), '', 123, null];
    for (const v of vectors) {
      const r = assertShellSafe(v);
      expect(r.ok, JSON.stringify(v)).toBe(false);
    }
  });

  it('长度上限可配置', () => {
    expect(assertShellSafe('abc', 'x', { maxLength: 2 }).ok).toBe(false);
    expect(assertShellSafe('abc', 'x', { maxLength: 3 }).ok).toBe(true);
  });
});

describe('assertShellSafeUrl', () => {
  it('接受 http(s) URL', () => {
    expect(assertShellSafeUrl('https://github.com/a/b/releases/download/v1/x.tgz').ok).toBe(true);
    expect(assertShellSafeUrl('http://x.y/z').ok).toBe(true);
  });
  it('拒绝：非 http(s) / 元字符 / 空白 / 控制字符', () => {
    for (const v of ['ftp://x/y', 'javascript:alert(1)', 'https://x/y?a=1&b=2;rm', 'https://x y', 'https://x\n', 'https://x\u0000', '', 'x', 1]) {
      const r = assertShellSafeUrl(v);
      expect(r.ok, JSON.stringify(v)).toBe(false);
    }
  });
  it('SHELL_SAFE_LIST 文档常量', () => {
    expect(SHELL_SAFE_LIST).toEqual(['0-9', 'A-Z', 'a-z', '.', '_', '-']);
  });
});
