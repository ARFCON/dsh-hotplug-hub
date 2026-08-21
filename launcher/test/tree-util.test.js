'use strict';
// test/tree-util.test.js — infra/tree-util.js 全覆盖（§8.5：遍历/删除工具 100%）
// 覆盖：hashBuffer 已知向量、entryType 四类条目、walkFiles（文件/目录递归/链接
// 不跟随/rel 正斜杠/readdir 失败容错）、collectAll（含目录与链接标记/递归）、
// removePath（单文件/目录树/符号链接 rmdir 优先/unlink 回退）。
const path = require('path');
const fs = require('fs');
const os = require('os');
const { hashBuffer, entryType, walkFiles, collectAll, removePath } = require('../infra/tree-util');
const { tempDir } = require('./helpers');

const realFs = {
  readdirSync: fs.readdirSync.bind(fs),
  lstatSync: fs.lstatSync.bind(fs),
  rmdirSync: fs.rmdirSync.bind(fs),
  unlinkSync: fs.unlinkSync.bind(fs)
};

function dirent(isSymlink, isDir, isFile) {
  return {
    isSymbolicLink: () => isSymlink,
    isDirectory: () => isDir,
    isFile: () => isFile
  };
}

describe('infra/tree-util.js 全覆盖', () => {
  describe('hashBuffer', () => {
    it('sha256 已知向量', () => {
      expect(hashBuffer(Buffer.from('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
      expect(hashBuffer(Buffer.from(''))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });
    it('不同内容哈希不同', () => {
      expect(hashBuffer(Buffer.from('a'))).not.toBe(hashBuffer(Buffer.from('b')));
    });
  });

  describe('entryType', () => {
    it('link / dir / file / other 四类', () => {
      expect(entryType(dirent(true, false, false))).toBe('link');
      expect(entryType(dirent(false, true, false))).toBe('dir');
      expect(entryType(dirent(false, false, true))).toBe('file');
      expect(entryType(dirent(false, false, false))).toBe('other');
    });
    it('无 isSymbolicLink 方法的条目（旧式对象）不崩溃', () => {
      expect(entryType({ isDirectory: () => true, isFile: () => false })).toBe('dir');
    });
  });

  describe('walkFiles（递归遍历）', () => {
    let root;
    beforeEach(() => {
      root = tempDir('tree-walk-');
      fs.mkdirSync(path.join(root, 'sub'));
      fs.writeFileSync(path.join(root, 'a.txt'), 'a');
      fs.writeFileSync(path.join(root, 'sub', 'b.txt'), 'b');
      fs.writeFileSync(path.join(root, 'sub', 'c.bin'), Buffer.from([1, 2, 3]));
    });
    afterEach(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('递归收集文件：rel 统一正斜杠，目录不出现', () => {
      const out = walkFiles(realFs, root, '', []);
      const rels = out.map((x) => x.rel).sort();
      expect(rels).toEqual(['a.txt', 'sub/b.txt', 'sub/c.bin']);
      for (const x of out) {
        expect(x.type).toBe('file');
        expect(path.isAbsolute(x.abs)).toBe(true);
      }
    });

    it('base 前缀：rel = base/name', () => {
      const out = walkFiles(realFs, path.join(root, 'sub'), 'sub', []);
      expect(out.map((x) => x.rel).sort()).toEqual(['sub/b.txt', 'sub/c.bin']);
    });

    it('链接不跟随：目录链接记录为 link，目标内容不被遍历', () => {
      const link = path.join(root, 'dirlink');
      fs.symlinkSync(path.join(root, 'sub'), link, 'junction');
      const out = walkFiles(realFs, root, '', []);
      const links = out.filter((x) => x.type === 'link');
      expect(links).toHaveLength(1);
      expect(links[0].rel).toBe('dirlink');
      // 目标内容仍只经真实目录路径出现一次
      const rels = out.filter((x) => x.type === 'file').map((x) => x.rel);
      expect(rels).not.toContain('dirlink/b.txt');
      expect(rels).toContain('sub/b.txt');
    });

    it('readdir 失败容错：返回已收集结果，不抛错', () => {
      const badFs = { ...realFs, readdirSync: () => { throw new Error('EACCES'); } };
      const out = walkFiles(badFs, root, '', []);
      expect(out).toEqual([]);
      // 部分失败：子目录读失败不影响兄弟文件
      const spy = (dir, opts) => {
        if (dir === path.join(root, 'sub')) throw new Error('EACCES');
        return fs.readdirSync(dir, opts);
      };
      const out2 = walkFiles({ ...realFs, readdirSync: spy }, root, '', []);
      expect(out2.map((x) => x.rel)).toEqual(['a.txt']);
    });
  });

  describe('collectAll（含目录条目）', () => {
    let root;
    beforeEach(() => {
      root = tempDir('tree-collect-');
      fs.mkdirSync(path.join(root, 'sub'));
      fs.writeFileSync(path.join(root, 'a.txt'), 'a');
      fs.writeFileSync(path.join(root, 'sub', 'b.txt'), 'b');
    });
    afterEach(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('收集文件+目录+链接，标记 isDir/isSymlink，rel 正斜杠', () => {
      fs.symlinkSync(path.join(root, 'sub'), path.join(root, 'ln'), 'junction');
      const out = collectAll(realFs, root, '', []);
      const byRel = Object.fromEntries(out.map((x) => [x.rel, x]));
      expect(byRel['sub'].isDir).toBe(true);
      expect(byRel['sub'].isSymlink).toBe(false);
      expect(byRel['a.txt'].isDir).toBe(false);
      expect(byRel['sub/b.txt'].isDir).toBe(false);
      expect(byRel['ln'].isSymlink).toBe(true);
      expect(byRel['ln'].isDir).toBe(false);
      // 链接不递归
      expect(out.filter((x) => x.rel.startsWith('ln/'))).toHaveLength(0);
    });

    it('readdir 失败容错', () => {
      const badFs = { ...realFs, readdirSync: () => { throw new Error('EACCES'); } };
      expect(collectAll(badFs, root, '', [])).toEqual([]);
    });
  });

  describe('removePath（删除）', () => {
    it('单文件', () => {
      const root = tempDir('tree-rm-file-');
      const f = path.join(root, 'x.txt');
      fs.writeFileSync(f, 'x');
      removePath(realFs, f);
      expect(fs.existsSync(f)).toBe(false);
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('目录树递归删除（含嵌套子目录与文件）', () => {
      const root = tempDir('tree-rm-tree-');
      fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
      fs.writeFileSync(path.join(root, 'a', 'f1'), '1');
      fs.writeFileSync(path.join(root, 'a', 'b', 'f2'), '2');
      removePath(realFs, root);
      expect(fs.existsSync(root)).toBe(false);
    });

    it('符号链接：rmdirSync 成功即删链接本身（junction 场景）', () => {
      const root = tempDir('tree-rm-link-');
      const target = path.join(root, 'target');
      const link = path.join(root, 'link');
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, 'f'), 'f');
      fs.symlinkSync(target, link, 'junction');
      removePath(realFs, link);
      expect(fs.existsSync(link)).toBe(false);
      expect(fs.existsSync(path.join(target, 'f'))).toBe(true); // 目标完好
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('符号链接：rmdirSync 抛错（POSIX 文件链接）→ unlinkSync 回退', () => {
      let rmdirCalls = 0;
      let unlinkCalls = 0;
      const fake = {
        lstatSync: () => ({ isSymbolicLink: () => true, isDirectory: () => false }),
        rmdirSync: () => { rmdirCalls += 1; throw new Error('EPERM'); },
        unlinkSync: () => { unlinkCalls += 1; },
        readdirSync: () => []
      };
      removePath(fake, '/fake/link');
      expect(rmdirCalls).toBe(1);
      expect(unlinkCalls).toBe(1);
    });

    it('lstatSync 抛错（目标不存在）→ 异常向上传播（调用方负责存在性）', () => {
      const fake = {
        lstatSync: () => { throw new Error('ENOENT'); },
        rmdirSync: () => {}, unlinkSync: () => {}, readdirSync: () => []
      };
      expect(() => removePath(fake, '/missing')).toThrow('ENOENT');
    });
  });
});
