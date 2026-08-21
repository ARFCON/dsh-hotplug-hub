'use strict';
// test/snapshot.test.js — 快照 / 回滚基本往返（深层覆盖在 launcher 测试）
const path = require('path');
const os = require('os');
const fs = require('fs');
const { createSnapshot, restoreSnapshot, snapshotDigest, cleanupResidue } = require('../fs/snapshot');

const nodeFs = {
  readFileSync: fs.readFileSync.bind(fs),
  writeFileSync: fs.writeFileSync.bind(fs),
  existsSync: fs.existsSync.bind(fs),
  mkdirSync: fs.mkdirSync.bind(fs),
  rmdirSync: fs.rmdirSync.bind(fs),
  copyFileSync: fs.copyFileSync.bind(fs),
  renameSync: fs.renameSync.bind(fs),
  readdirSync: fs.readdirSync.bind(fs),
  statSync: fs.statSync.bind(fs),
  lstatSync: fs.lstatSync.bind(fs),
  readSync: fs.readSync.bind(fs),
  writeSync: fs.writeSync.bind(fs),
  ftruncateSync: fs.ftruncateSync.bind(fs),
  unlinkSync: fs.unlinkSync.bind(fs),
  rmSync: fs.rmSync.bind(fs),
  openSync: fs.openSync.bind(fs),
  closeSync: fs.closeSync.bind(fs),
  fsyncSync: fs.fsyncSync.bind(fs),
  symlinkSync: fs.symlinkSync.bind(fs),
  realpathSync: fs.realpathSync.bind(fs)
};

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shared-snap-'));
}

describe('createSnapshot / restoreSnapshot', () => {
  it('往返：快照→改动→回滚→内容一致', () => {
    const base = tempDir();
    const dir = path.join(base, 'target'); // 嵌套一层：externalDir 落在 base 内可断言
    fs.mkdirSync(dir);
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'a.txt'), 'aaa');
    fs.writeFileSync(path.join(dir, 'sub', 'b.bin'), Buffer.from([0, 1, 2, 255]));
    const s = createSnapshot(nodeFs, dir, { createdAt: '2026-01-01T00:00:00.000Z' });
    expect(s.ok).toBe(true);
    expect(s.snapshot.files.length).toBe(2);
    // 改动
    fs.writeFileSync(path.join(dir, 'a.txt'), 'CHANGED');
    fs.writeFileSync(path.join(dir, 'extra.txt'), 'new');
    const r = restoreSnapshot(nodeFs, s.snapshot, dir, { stamp: 't1' });
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('aaa');
    expect(fs.existsSync(path.join(dir, 'extra.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'sub', 'b.bin'))).toEqual(Buffer.from([0, 1, 2, 255]));
    // 外部备份目录已清理（base 内无 snapbak 残留）
    const leftovers = fs.readdirSync(base).filter((f) => f.includes('snapbak'));
    expect(leftovers).toHaveLength(0);
  });

  it('不存在的目录快照为空', () => {
    const dir = tempDir();
    const s = createSnapshot(nodeFs, path.join(dir, 'nope'), {});
    expect(s.ok).toBe(true);
    expect(s.snapshot.files).toHaveLength(0);
  });

  it('snapshotDigest 稳定', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'aaa');
    const s1 = createSnapshot(nodeFs, dir, { createdAt: '2026-01-01T00:00:00.000Z' });
    const d1 = snapshotDigest(s1.snapshot);
    const s2 = createSnapshot(nodeFs, dir, { createdAt: '2026-01-01T00:00:00.000Z' });
    expect(snapshotDigest(s2.snapshot)).toBe(d1);
  });
});

describe('cleanupResidue', () => {
  it('删除白名单外残留、保留 keep', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'k');
    fs.mkdirSync(path.join(dir, 'logs'));
    fs.writeFileSync(path.join(dir, 'logs', 'x.log'), 'l');
    fs.writeFileSync(path.join(dir, 'junk.txt'), 'j');
    const r = cleanupResidue(nodeFs, dir, { root: path.dirname(dir), keep: ['keep.txt'], keepPrefix: ['logs'] });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(dir, 'keep.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'logs', 'x.log'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'junk.txt'))).toBe(false);
  });
  it('root 越界防护', () => {
    const dir = tempDir();
    const r = cleanupResidue(nodeFs, path.join(dir, '..', '..'), { root: dir });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_ARG_PATH_ESCAPE');
  });
});
