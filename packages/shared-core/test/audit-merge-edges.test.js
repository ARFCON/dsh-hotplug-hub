'use strict';
// test/audit-merge-edges.test.js — 审计：profile/merge.js 分节保留合并的边界验证（可疑点 7）
// 结论：marker 精确匹配、id 含 .、CRLF、相邻块、空文件、末尾无换行 均无 bug（证伪）。
// 本文件以断言固化这些边界，防止回归。
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

function tempDir(prefix = 'audit-merge-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('PATCH_MARKER_RE 精确匹配边界', () => {
  it('双/单 #、空格、紧凑形态、尾随文本、id 含 . 的判定全部正确', () => {
    expect(PATCH_MARKER_RE.test('## owner:id')).toBe(true);
    expect(PATCH_MARKER_RE.test('# owner:id')).toBe(true);
    expect(PATCH_MARKER_RE.test('## owner:pack.x')).toBe(true); // id 含 .（字符类内，非正则特殊）
    expect(PATCH_MARKER_RE.test('## owner:a-b_c.d')).toBe(true); // 全字符集
    expect(PATCH_MARKER_RE.test('##owner:id')).toBe(false); // 无空格
    expect(PATCH_MARKER_RE.test('## owner:id extra')).toBe(false); // 尾随文本
    expect(PATCH_MARKER_RE.test('## owner:id:extra')).toBe(false); // id 中不允许 :
    expect(PATCH_MARKER_RE.test('  ## owner:id')).toBe(false); // 行首缩进不算 marker
    expect(PATCH_MARKER_RE.test('### owner:id')).toBe(false); // 3 个 #
  });
});

describe('findPatchBlock 边界', () => {
  it('id 含 . 的正则特殊字符定位正确（. 在字符类内为字面量）', () => {
    const text = '## hotplug:pack.x\nblock\n## other:y\nz\n';
    const r = findPatchBlock(text, 'hotplug', 'pack.x');
    expect(r).toEqual({ found: true, start: 0, end: 2 });
    expect(findPatchBlock(text, 'hotplug', 'packx').found).toBe(false); // . 不被当通配
  });

  it('CRLF 未归一化直接传入：\\s*$ 吸收 \\r，仍能定位（健壮性）', () => {
    const text = '## a:1\r\nblock-a\r\n## b:2\r\nblock-b\r\n';
    const r = findPatchBlock(text, 'a', '1');
    expect(r.found).toBe(true);
    expect(r.start).toBe(0);
  });

  it('多个同 owner 不同 id 块：仅替换目标块，其余原样保留', () => {
    const text = '## owner:a\nA\n## owner:b\nB\n## owner:c\nC\n';
    const dir = tempDir();
    const file = path.join(dir, 'p.yml');
    fs.writeFileSync(file, text);
    const r = mergePatchFile(nodeFs, file, 'owner', 'b', '- insert:\n    - id: NEW');
    expect(r.ok).toBe(true);
    const out = fs.readFileSync(file, 'utf8');
    expect(out).toContain('## owner:a\nA\n');
    expect(out).toContain('## owner:b\n- insert:\n    - id: NEW\n');
    expect(out).toContain('## owner:c\nC\n');
    // 三个块顺序不变
    expect(out.indexOf('owner:a')).toBeLessThan(out.indexOf('owner:b'));
    expect(out.indexOf('owner:b')).toBeLessThan(out.indexOf('owner:c'));
  });
});

describe('mergePatchFile 换行拼接边界', () => {
  it('空文件追加：不产生多余空行', () => {
    const dir = tempDir();
    const file = path.join(dir, 'p.yml');
    const r = mergePatchFile(nodeFs, file, 'hotplug', 'a', '- insert: []');
    expect(r.ok).toBe(true);
    const out = fs.readFileSync(file, 'utf8');
    expect(out).toBe('## hotplug:a\n- insert: []\n');
  });

  it('文件末尾无换行 → 追加前补一个换行，块之间无粘连', () => {
    const dir = tempDir();
    const file = path.join(dir, 'p.yml');
    fs.writeFileSync(file, '## desktop:keep\n- insert: []'); // 无末尾换行
    const r = mergePatchFile(nodeFs, file, 'hotplug', 'a', '- insert: []');
    expect(r.ok).toBe(true);
    const out = fs.readFileSync(file, 'utf8');
    expect(out).toBe('## desktop:keep\n- insert: []\n## hotplug:a\n- insert: []\n');
  });

  it('块相邻（无空行分隔）：替换后不吞并/不粘连', () => {
    const dir = tempDir();
    const file = path.join(dir, 'p.yml');
    fs.writeFileSync(file, '## a:1\nA\n## b:2\nB\n');
    const r = mergePatchFile(nodeFs, file, 'a', '1', 'A-NEW');
    expect(r.ok).toBe(true);
    const out = fs.readFileSync(file, 'utf8');
    expect(out).toBe('## a:1\nA-NEW\n## b:2\nB\n');
  });
});

describe('removePatchBlock 接缝清理边界', () => {
  it('删除中间块：head 与 tail 接缝只保留一个换行', () => {
    const dir = tempDir();
    const file = path.join(dir, 'p.yml');
    fs.writeFileSync(file, '# c\n## a:1\nA\n## b:2\nB\n');
    const r = removePatchBlock(nodeFs, file, 'a', '1');
    expect(r.ok).toBe(true);
    expect(r.removed).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('# c\n## b:2\nB\n');
  });

  it('删除顶部块（head 为空）：结果以 tail 开头，无前导空行', () => {
    const dir = tempDir();
    const file = path.join(dir, 'p.yml');
    fs.writeFileSync(file, '## a:1\nA\n## b:2\nB\n');
    const r = removePatchBlock(nodeFs, file, 'a', '1');
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('## b:2\nB\n');
  });
});
