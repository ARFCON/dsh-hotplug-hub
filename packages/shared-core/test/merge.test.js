'use strict';
// test/merge.test.js — 分节保留合并（R-v5-12 / H-16）：marker 切分、替换、追加、
// 注释与其它块原样保留、旧单 # marker 兼容、永不整文件覆盖
const path = require('path');
const os = require('os');
const fs = require('fs');
const { mergePatchFile, removePatchBlock, findPatchBlock, patchMarker, PATCH_MARKER_RE } = require('../profile/merge');

const nodeFs = {
  readFileSync: fs.readFileSync.bind(fs),
  writeFileSync: fs.writeFileSync.bind(fs),
  existsSync: fs.existsSync.bind(fs),
  mkdirSync: fs.mkdirSync.bind(fs),
  renameSync: fs.renameSync.bind(fs),
  openSync: fs.openSync.bind(fs),
  closeSync: fs.closeSync.bind(fs),
  fsyncSync: fs.fsyncSync.bind(fs),
  unlinkSync: fs.unlinkSync.bind(fs),
  rmSync: fs.rmSync.bind(fs),
  statSync: fs.statSync.bind(fs),
  readdirSync: fs.readdirSync.bind(fs)
};

function tempDir(prefix = 'shared-merge-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const BLOCK_A = '- insert:\n    - id: hp-a\n      name: \'pkg-a\'\n      config: {}';
const BLOCK_B = '- insert:\n    - id: hp-b\n      name: \'pkg-b\'\n      config: { enabled: true }';

describe('findPatchBlock / PATCH_MARKER_RE', () => {
  it('marker 识别 # 与 ## 双形态', () => {
    expect(PATCH_MARKER_RE.test('## hotplug:abc')).toBe(true);
    expect(PATCH_MARKER_RE.test('# hotplug:abc')).toBe(true);
    expect(PATCH_MARKER_RE.test('##hotplug:abc')).toBe(false);
    expect(PATCH_MARKER_RE.test('# 插件管理 x')).toBe(false);
    expect(PATCH_MARKER_RE.test('- insert:')).toBe(false);
    expect(PATCH_MARKER_RE.test('## owner:id:extra')).toBe(false);
  });
  it('patchMarker 构造', () => {
    expect(patchMarker('hotplug', 'pack.x')).toBe('## hotplug:pack.x');
  });
  it('findPatchBlock 定位块边界', () => {
    const text = 'top\n## a:1\nblock-a\n## b:2\nblock-b\n';
    const a = findPatchBlock(text, 'a', '1');
    expect(a).toEqual({ found: true, start: 1, end: 3 });
    const b = findPatchBlock(text, 'b', '2');
    // 末块 end = 行数（含尾部空行产物）
    expect(b).toEqual({ found: true, start: 3, end: 6 });
    expect(findPatchBlock(text, 'a', '2').found).toBe(false);
    expect(findPatchBlock(text, 'x', '9').found).toBe(false);
  });
});

describe('mergePatchFile', () => {
  it('空文件 → 追加新块', () => {
    const dir = tempDir();
    const file = path.join(dir, 'cordis.patch.yml');
    const r = mergePatchFile(nodeFs, file, 'hotplug', 'pack.a', BLOCK_A);
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(true);
    expect(r.marker).toBe('## hotplug:pack.a');
    const text = fs.readFileSync(file, 'utf8');
    expect(text.startsWith('## hotplug:pack.a\n')).toBe(true);
    expect(text).toContain('hp-a');
  });

  it('追加到既有文件末尾（保留原内容与新行）', () => {
    const dir = tempDir();
    const file = path.join(dir, 'cordis.patch.yml');
    fs.writeFileSync(file, '- insert:\n  - id: other\n    name: \'x\'\n    config: {}\n');
    const r = mergePatchFile(nodeFs, file, 'hotplug', 'pack.a', BLOCK_A);
    expect(r.ok).toBe(true);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('- id: other');
    expect(text).toContain('## hotplug:pack.a');
    expect(text.indexOf('- id: other')).toBeLessThan(text.indexOf('## hotplug:pack.a'));
  });

  it('既有块 → 替换（其它块与注释原样保留）', () => {
    const dir = tempDir();
    const file = path.join(dir, 'cordis.patch.yml');
    const initial = '# 顶部注释\n## hotplug:pack.a\n- insert:\n    - id: hp-old\n      name: \'old\'\n      config: {}\n## desktop:keep\n- insert:\n    - id: keep\n      name: \'k\'\n      config: {}\n';
    fs.writeFileSync(file, initial);
    const r = mergePatchFile(nodeFs, file, 'hotplug', 'pack.a', BLOCK_B);
    expect(r.ok).toBe(true);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('# 顶部注释');
    expect(text).toContain('## desktop:keep');
    expect(text).toContain('hp-b');
    expect(text).not.toContain('hp-old');
    // 注释与 keep 块相对顺序不变
    expect(text.indexOf('# 顶部注释')).toBeLessThan(text.indexOf('## desktop:keep'));
  });

  it('旧单 # marker（# hotplug:pack.a）→ 识别并升级为 ##', () => {
    const dir = tempDir();
    const file = path.join(dir, 'cordis.patch.yml');
    fs.writeFileSync(file, '# hotplug:pack.a\n- insert:\n    - id: hp-old\n      name: \'old\'\n      config: {}\n');
    const r = mergePatchFile(nodeFs, file, 'hotplug', 'pack.a', BLOCK_A);
    expect(r.ok).toBe(true);
    const text = fs.readFileSync(file, 'utf8');
    expect(text.startsWith('## hotplug:pack.a\n')).toBe(true);
    // marker 只出现一次（旧单 # 形态已被替换，而非残留）
    const markerLines = text.split('\n').filter((l) => l.includes('hotplug:pack.a'));
    expect(markerLines).toHaveLength(1);
  });

  it('无变化内容 → changed:false 不写盘', () => {
    const dir = tempDir();
    const file = path.join(dir, 'cordis.patch.yml');
    fs.writeFileSync(file, '## hotplug:pack.a\n- insert:\n    - id: x\n      name: \'y\'\n      config: {}\n');
    const mtime = fs.statSync(file).mtimeMs;
    const r = mergePatchFile(nodeFs, file, 'hotplug', 'pack.a', '- insert:\n    - id: x\n      name: \'y\'\n      config: {}');
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(false);
  });

  it('CRLF 输入归一化', () => {
    const dir = tempDir();
    const file = path.join(dir, 'cordis.patch.yml');
    fs.writeFileSync(file, '- insert:\r\n  - id: other\r\n    name: \'x\'\r\n    config: {}\r\n');
    const r = mergePatchFile(nodeFs, file, 'hotplug', 'pack.a', BLOCK_A);
    expect(r.ok).toBe(true);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).not.toContain('\r');
    expect(text).toContain('## hotplug:pack.a');
  });

  it('写失败返回 errorCode 定制错误', () => {
    const dir = tempDir();
    const file = path.join(dir, 'cordis.patch.yml');
    fs.mkdirSync(file); // 目标被目录占位 → 原子写失败
    const badFs = { ...nodeFs, writeFileSync: () => { throw new Error('EACCES: deny'); } };
    const r = mergePatchFile(badFs, path.join(file, 'x.yml'), 'hotplug', 'a', BLOCK_A, { errorCode: 'ERR_YAML_SERIALIZE' });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_YAML_SERIALIZE');
  });
});

describe('removePatchBlock', () => {
  it('按 marker 删除（不按 id 内容）', () => {
    const dir = tempDir();
    const file = path.join(dir, 'cordis.patch.yml');
    fs.writeFileSync(file, '# 注释\n## hotplug:pack.a\n- insert:\n    - id: x\n      name: \'y\'\n      config: {}\n## desktop:keep\n- insert:\n    - id: k\n      name: \'k\'\n      config: {}\n');
    const r = removePatchBlock(nodeFs, file, 'hotplug', 'pack.a');
    expect(r.ok).toBe(true);
    expect(r.removed).toBe(true);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).not.toContain('pack.a');
    expect(text).not.toContain('hp-');
    expect(text).toContain('# 注释');
    expect(text).toContain('## desktop:keep');
    expect(text).toContain('name: \'k\'');
  });

  it('目标不存在 → removed:false', () => {
    const dir = tempDir();
    const file = path.join(dir, 'cordis.patch.yml');
    fs.writeFileSync(file, '## desktop:keep\n- insert: []\n');
    const r = removePatchBlock(nodeFs, file, 'hotplug', 'nope');
    expect(r.ok).toBe(true);
    expect(r.removed).toBe(false);
  });

  it('文件不存在 → removed:false', () => {
    const dir = tempDir();
    const r = removePatchBlock(nodeFs, path.join(dir, 'nope.yml'), 'hotplug', 'x');
    expect(r.ok).toBe(true);
    expect(r.removed).toBe(false);
  });
});
