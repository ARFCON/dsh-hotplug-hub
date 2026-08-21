'use strict';
// test/qa3-ids-exhaustive.test.js — ids 穿越穷尽（QA3 第 2 层主题 1）
// 在既有 14 向量矩阵之外追加：8.3 短名 / 大小写变体 / URL 编码 / 全角 / 超长 / 符号链接目录。
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  validateId,
  isWithin,
  assertWithin,
  normalizeAndAssert,
  PACK_ID_RE,
  MAX_ID_LENGTH
} = require('../domain/ids');
const { tempDir } = require('./helpers');

describe('QA3 ids 穿越穷尽（D/N30/N31/N32/N43 强化）', () => {
  const EXTRA_VECTORS = [
    'C:\\PROGRA~1',       // Windows 8.3 短名形态（含冒号/反斜杠）
    '..\\..',             // 纯双反斜杠穿越
    '..\\..\\..',         // 多级反斜杠
    '.../x',              // 三点斜杠
    '%2e%2e',             // URL 编码 ..（% 不在白名单，不解码直接拒绝）
    '..%5c',              // URL 编码反斜杠
    '%2e%2e%2f',          // 全 URL 编码穿越
    'a%2f..%2fb',         // 混合编码
    '.',                  // 纯点
    '..\\',               // 反斜杠结尾
    '..\\C:',             // 反斜杠+盘符
    '..\\x',              // 反斜杠相对
    './../x',             // 斜杠相对
    'a/../../../../x',    // 更深相对
    'a\\..\\..\\..\\x',  // 反斜杠深相对
    'C:/Windows/System32',// 盘符斜杠
    '\\\\server\\share',  // UNC
    '//server/share',     // 正斜杠 UNC
    'CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM9', 'LPT1', 'LPT9',
    'con.txt', 'NUL.log', 'COM1.bak',
    'a'.repeat(65),       // 超长 65
    'a'.repeat(MAX_ID_LENGTH + 1),
    '\uFF0E\uFF0E',       // 全角 ．．
    '\uFF0E\uFF0E/x',     // 全角穿越
    '中文穿越',            // 非 ASCII
    'a\u0000b',           // 控制字符
    'a\nb',               // 换行
    'abc.',               // 尾部点
    'abc ',               // 尾部空格
    ' abc',               // 前导空格
    '-abc',               // 前导连字符（白名单首位要求字母数字）
    'a b',                // 内嵌空格
    'a/b',                // 斜杠
    'a\\b'                // 反斜杠
  ];

  it('追加穿越/非法向量全部拒绝（共 ' + EXTRA_VECTORS.length + ' 项）', () => {
    for (const v of EXTRA_VECTORS) {
      const r = validateId(v);
      expect(r.ok, `应拒绝非法 id: ${JSON.stringify(v)}`).toBe(false);
      expect(r.error.code.startsWith('ERR_ARG_'), `错误码前缀: ${JSON.stringify(v)}`).toBe(true);
    }
  });

  it('合法边界：1 字符 / 64 字符 / 大小写 / 点连字符下划线', () => {
    for (const id of ['a', 'z', 'A', 'Z', 'a'.repeat(64), 'pkg-a.b_c', 'A1_b-c.d', 'example']) {
      const r = validateId(id);
      expect(r.ok, `应接受合法 id: ${JSON.stringify(id)}`).toBe(true);
    }
    // 64 字符 = 上界
    expect(validateId('a'.repeat(64)).ok).toBe(true);
    // 65 字符 = 越界
    expect(validateId('a'.repeat(65)).ok).toBe(false);
  });

  it('非字符串输入（null/undefined/数字/对象/数组）全部拒绝', () => {
    for (const bad of [null, undefined, 123, {}, [], true, Symbol('x')]) {
      const r = validateId(bad);
      expect(r.ok, `应拒绝非字符串: ${String(bad)}`).toBe(false);
    }
  });

  it('normalizeAndAssert：合法 id 拼接后恒在 root 内', () => {
    const root = tempDir('qa3-ids-root-');
    for (const id of ['a', 'pkg-x', 'a'.repeat(64), 'A1_b-c.d']) {
      const r = normalizeAndAssert(id, root);
      expect(r.ok, `合法 id 应通过: ${id}`).toBe(true);
      const target = path.join(root, id);
      expect(isWithin(root, target)).toBe(true);
    }
  });

  it('normalizeAndAssert：穿越 id 返回 ERR_ARG_* 且不产生越界路径', () => {
    const root = tempDir('qa3-ids-root-');
    for (const v of ['..', '../x', '..\\x', 'a/../../../x', 'C:\\Windows', '/etc']) {
      const r = normalizeAndAssert(v, root);
      expect(r.ok, `应拒绝: ${JSON.stringify(v)}`).toBe(false);
      expect(r.error.code.startsWith('ERR_ARG_')).toBe(true);
    }
    // root 下零文件产生
    const entries = fs.readdirSync(root);
    expect(entries).toHaveLength(0);
  });

  it('isWithin 边界：根自身 / 兄弟 / 深层 / 相对路径', () => {
    const root = path.resolve(tempDir('qa3-iswithin-'));
    const inside = path.join(root, 'a', 'b', 'c');
    const sibling = path.join(path.dirname(root), 'other');
    expect(isWithin(root, root)).toBe(true);
    expect(isWithin(root, inside)).toBe(true);
    expect(isWithin(root, sibling)).toBe(false);
    expect(isWithin(root, path.join(root, '..', 'x'))).toBe(false);
    // 未 resolve 的相对形态
    expect(isWithin(root, path.join(root, 'a', '..', 'b'))).toBe(true); // 归一化后仍在根内
    expect(isWithin(root, path.join(root, '..'))).toBe(false);
  });

  it('assertWithin 返回 ERR_ARG_PATH_ESCAPE（exit=2 域）', () => {
    const root = path.resolve(tempDir('qa3-assertwithin-'));
    const r = assertWithin(root, path.join(path.dirname(root), 'evil'), '测试目标');
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_ARG_PATH_ESCAPE');
    expect(r.error.exitCode).toBe(2);
  });

  it('符号链接目录（junction）越界：isWithinRealpath 拒（C-1 修复），removePath 只删链接本身', () => {
    const root = tempDir('qa3-symlink-');
    const outside = tempDir('qa3-symlink-out-');
    const link = path.join(root, 'linkdir');
    try {
      fs.symlinkSync(outside, link, 'junction');
    } catch (e) {
      // 无权限创建符号链接的环境跳过（标注）
      console.log('SKIP symlink: ' + e.code);
      return;
    }
    const fsPort = {
      existsSync: fs.existsSync.bind(fs),
      realpathSync: fs.realpathSync.bind(fs)
    };
    // C-1 修复：realpath 整路径比真根——junction 指向根外 → 拒绝
    const { isWithinRealpath, assertWithinRealpath } = require('../domain/ids');
    expect(isWithinRealpath(fsPort, root, link)).toBe(false);
    expect(isWithinRealpath(fsPort, root, path.join(link, 'victim.txt'))).toBe(false);
    const r = assertWithinRealpath(fsPort, root, path.join(link, 'victim.txt'), '测试目标');
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_ARG_PATH_ESCAPE');
    expect(r.error.exitCode).toBe(2);
    // 词法语义（尚不存在的目标预检）仍保留
    const { isWithin } = require('../domain/ids');
    expect(isWithin(root, link)).toBe(true);
    // 越界写防护的现实验证：cleanupResidue/restoreSnapshot 使用 lstat 语义的
    // removePath，不会跟随链接删除目标
    const outsideFile = path.join(outside, 'victim.txt');
    fs.writeFileSync(outsideFile, 'safe');
    const { removePath } = require('../infra/snapshot');
    removePath({ lstatSync: fs.lstatSync.bind(fs), readdirSync: fs.readdirSync.bind(fs), rmdirSync: fs.rmdirSync.bind(fs), unlinkSync: fs.unlinkSync.bind(fs) }, link);
    expect(fs.existsSync(outsideFile)).toBe(true); // 目标完好
    expect(fs.existsSync(link)).toBe(false);       // 仅链接被删
  });
});
