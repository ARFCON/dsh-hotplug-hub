'use strict';
// test/path-safe.test.js — isWithin / assertWithin（词法）+ realpath 变体（C-1）+
// safeJoin（H-5/M-5 拒绝集）
const path = require('path');
const os = require('os');
const fs = require('fs');
const {
  isWithin, assertWithin, isWithinRealpath, assertWithinRealpath, resolveExistingAncestor,
  safeJoin, checkWindowsSafeName
} = require('../fs/path-safe');

const nodeFs = {
  existsSync: fs.existsSync.bind(fs),
  realpathSync: fs.realpathSync.bind(fs),
  statSync: fs.statSync.bind(fs),
  lstatSync: fs.lstatSync.bind(fs),
  symlinkSync: fs.symlinkSync.bind(fs),
  mkdirSync: fs.mkdirSync.bind(fs),
  writeFileSync: fs.writeFileSync.bind(fs)
};

describe('isWithin / assertWithin（阶段 0 路径语义）', () => {
  const root = path.resolve(fs.mkdtempSync(path.join(os.tmpdir(), 'shared-within-')));

  it('根自身 / 深层 / 兄弟 / 相对形态', () => {
    const inside = path.join(root, 'a', 'b');
    const sibling = path.join(path.dirname(root), 'other');
    expect(isWithin(root, root)).toBe(true);
    expect(isWithin(root, inside)).toBe(true);
    expect(isWithin(root, sibling)).toBe(false);
    expect(isWithin(root, path.join(root, '..', 'x'))).toBe(false);
    expect(isWithin(root, path.join(root, 'a', '..', 'b'))).toBe(true);
    expect(isWithin(root, path.join(root, '..'))).toBe(false);
  });

  it('assertWithin 返回 ERR_ARG_PATH_ESCAPE（exit=2 域）', () => {
    const r = assertWithin(root, path.join(path.dirname(root), 'evil'), '测试目标');
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_ARG_PATH_ESCAPE');
    expect(r.error.exitCode).toBe(2);
    expect(assertWithin(root, path.join(root, 'ok')).ok).toBe(true);
  });
});

describe('isWithinRealpath / assertWithinRealpath（C-1：junction/symlink 越界拒、合法软链收）', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-realpath-'));
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);

  it('普通路径：根内收、根外拒', () => {
    expect(isWithinRealpath(nodeFs, root, path.join(root, 'a'))).toBe(true);
    expect(isWithinRealpath(nodeFs, root, outside)).toBe(false);
    expect(isWithinRealpath(nodeFs, root, path.join(outside, 'x'))).toBe(false);
  });

  it('symlink 越界拒（指向根外）', () => {
    let link = path.join(root, 'esc');
    try {
      fs.symlinkSync(outside, link, 'junction');
    } catch (e) {
      console.log('SKIP symlink: ' + e.code);
      return;
    }
    // 已存在的链接目标：整路径解析后越界
    expect(isWithinRealpath(nodeFs, root, link)).toBe(false);
    // 链接下不存在的子路径：经最深已存在祖先（链接本身）解析后仍越界
    expect(isWithinRealpath(nodeFs, root, path.join(link, 'victim.txt'))).toBe(false);
    const r = assertWithinRealpath(nodeFs, root, path.join(link, 'victim.txt'), '测试');
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_ARG_PATH_ESCAPE');
  });

  it('合法软链收（链接指向根内另一目录）', () => {
    const inner = path.join(root, 'inner');
    fs.mkdirSync(inner);
    const link = path.join(root, 'alias');
    try {
      fs.symlinkSync(inner, link, 'junction');
    } catch (e) {
      console.log('SKIP symlink: ' + e.code);
      return;
    }
    expect(isWithinRealpath(nodeFs, root, path.join(link, 'f.txt'))).toBe(true);
    const r = assertWithinRealpath(nodeFs, root, path.join(link, 'f.txt'), '合法');
    expect(r.ok).toBe(true);
    // resolvedPath 指向真实位置
    expect(r.resolvedPath).toBe(path.join(inner, 'f.txt'));
  });

  it('root 自身为软链：以真实根为准（合法软链收）', () => {
    const realRoot = path.join(base, 'real-root');
    fs.mkdirSync(realRoot);
    const rootLink = path.join(base, 'root-link');
    try {
      fs.symlinkSync(realRoot, rootLink, 'junction');
    } catch (e) {
      console.log('SKIP symlink: ' + e.code);
      return;
    }
    expect(isWithinRealpath(nodeFs, rootLink, path.join(rootLink, 'x'))).toBe(true);
    expect(isWithinRealpath(nodeFs, rootLink, outside)).toBe(false);
  });

  it('不存在的目标：经最深已存在祖先解析', () => {
    fs.mkdirSync(path.join(root, 'deep'));
    expect(isWithinRealpath(nodeFs, root, path.join(root, 'deep', 'a', 'b', 'c'))).toBe(true);
    expect(isWithinRealpath(nodeFs, root, path.join(root, 'deep', '..', '..', 'outside'))).toBe(false);
  });

  it('resolveExistingAncestor 单元', () => {
    fs.mkdirSync(path.join(root, 'anc'));
    const r = resolveExistingAncestor(nodeFs, path.join(root, 'anc', 'x', 'y'));
    expect(r.ok).toBe(true);
    expect(r.resolved).toBe(path.join(root, 'anc', 'x', 'y'));
    const r2 = resolveExistingAncestor(nodeFs, path.join(root, 'anc'));
    expect(r2.ok).toBe(true);
    expect(r2.resolved).toBe(path.join(root, 'anc'));
  });

  it('根 realpath 失败 → deny（不静默放行）', () => {
    const badFs = { ...nodeFs, realpathSync: () => { const e = new Error('ELOOP'); e.code = 'ELOOP'; throw e; } };
    const r = assertWithinRealpath(badFs, root, path.join(root, 'x'), 't');
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_ARG_PATH_ESCAPE');
  });
});

describe('safeJoin（H-5/M-5 拒绝集）', () => {
  const root = path.resolve(fs.mkdtempSync(path.join(os.tmpdir(), 'shared-safejoin-')));

  it('合法段拼接', () => {
    const r = safeJoin(root, 'a', 'b-c.d', 'E1');
    expect(r.ok).toBe(true);
    expect(r.path).toBe(path.join(root, 'a', 'b-c.d', 'E1'));
    expect(safeJoin(root, 'single').ok).toBe(true);
  });

  it('拒绝：绝对/盘符/UNC/前导斜杠/~', () => {
    for (const bad of ['C:\\x', 'C:/x', '/abs', '\\\\server\\share', '~user', '~/x']) {
      const r = safeJoin(root, bad);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      expect(r.error.code).toBe('ERR_ARG_PATH_ESCAPE');
    }
  });

  it('拒绝：.. / . / 分隔符 / 空段', () => {
    for (const bad of ['..', '.', 'a/b', 'a\\b', '', 'a\u0000b']) {
      const r = safeJoin(root, bad);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('拒绝：保留名 / 尾点空格 / 控制字符 / 超长', () => {
    for (const bad of ['CON', 'nul', 'COM1', 'a.', 'a ', 'a\u0085b', 'x'.repeat(256)]) {
      const r = safeJoin(root, bad);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('拼接结果越界防护（多段组合）', () => {
    // 单段拒绝已覆盖；再验证组合后仍在根内
    const r = safeJoin(root, 'a', 'b', 'c');
    expect(r.ok).toBe(true);
    expect(isWithin(root, r.path)).toBe(true);
  });

  it('checkWindowsSafeName 独立行为', () => {
    expect(checkWindowsSafeName('ok-name').ok).toBe(true);
    expect(checkWindowsSafeName('CON').ok).toBe(false);
    expect(checkWindowsSafeName('x.').ok).toBe(false);
    expect(checkWindowsSafeName('x\u0000').ok).toBe(false);
  });
});
