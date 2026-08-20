'use strict';
// test/qa3-snapshot-extra.test.js — snapshot/cleanupResidue 强化（QA3 第 2 层主题 9）
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../app/create-core');
const { createFsPort } = require('../ports/fs');
const { createSnapshot, restoreSnapshot, cleanupResidue, snapshotDigest } = require('../infra/snapshot');

const fsPort = createFsPort(fs);

function tmpDir(prefix = 'qa3-snap-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('QA3 snapshot/cleanupResidue 强化（审计 H/N37/N33 强化）', () => {
  it('越界防护：尝试清理 root 外文件被拒且不删除', () => {
    const root = tmpDir('qa3-snap-root-');
    const outside = path.join(root, '..', 'qa3-outside-' + Date.now());
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'victim.txt'), 'keep');
    const r = cleanupResidue(fsPort, outside, { root, keep: [] });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_ARG_PATH_ESCAPE');
    expect(fs.existsSync(path.join(outside, 'victim.txt'))).toBe(true);
  });

  it('白名单保留：keep + keepPrefix 递归保留', () => {
    const dir = tmpDir('qa3-snap-clean-');
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.mkdirSync(path.join(dir, 'logs', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'logs', 'sub', 'run.jsonl'), 'x');
    fs.mkdirSync(path.join(dir, 'node_modules', 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'a', 'b', 'f.js'), 'x');
    fs.writeFileSync(path.join(dir, 'stray.txt'), 'x');
    const r = cleanupResidue(fsPort, dir, { keep: ['package.json'], keepPrefix: ['logs'] });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(dir, 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'logs', 'sub', 'run.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'node_modules'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'stray.txt'))).toBe(false);
  });

  it('符号链接：cleanup 删除链接本身，不触碰链接目标（防越界删除）', () => {
    const dir = tmpDir('qa3-snap-sym-');
    const target = tmpDir('qa3-snap-target-');
    fs.writeFileSync(path.join(target, 'keep.txt'), 'keep');
    const link = path.join(dir, 'evillink');
    try {
      fs.symlinkSync(target, link, 'junction');
    } catch (e) {
      console.log('SKIP symlink creation: ' + e.code);
      return;
    }
    fs.writeFileSync(path.join(dir, 'stray.txt'), 'x');
    const r = cleanupResidue(fsPort, dir, { keep: [] });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(link)).toBe(false); // 链接被删
    expect(fs.existsSync(path.join(target, 'keep.txt'))).toBe(true); // 目标完好
  });

  it('嵌套目录清理：深层残留全部删除', () => {
    const dir = tmpDir('qa3-snap-nest-');
    fs.mkdirSync(path.join(dir, 'a', 'b', 'c'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a', 'b', 'c', 'deep.txt'), 'x');
    fs.mkdirSync(path.join(dir, 'deep2', 'x'), { recursive: true });
    const r = cleanupResidue(fsPort, dir, { keep: [] });
    expect(r.ok).toBe(true);
    expect(fs.readdirSync(dir)).toHaveLength(0);
  });

  it('快照回滚删除新增文件/目录（含快照目录内的新增）', () => {
    const dir = tmpDir('qa3-snap-restore-');
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.txt'), 'A');
    fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'B');
    const snap = createSnapshot(fsPort, dir);
    expect(snap.ok).toBe(true);
    // 新增：快照内目录的新文件 + 全新目录
    fs.writeFileSync(path.join(dir, 'sub', 'new.txt'), 'N');
    fs.mkdirSync(path.join(dir, 'brandnew'));
    fs.writeFileSync(path.join(dir, 'brandnew', 'x.txt'), 'X');
    const r = restoreSnapshot(fsPort, snap.snapshot, dir);
    expect(r.ok).toBe(true);
    expect(r.removed).toEqual(expect.arrayContaining(['sub/new.txt', 'brandnew/x.txt']));
    expect(fs.existsSync(path.join(dir, 'a.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'sub', 'b.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'sub', 'new.txt'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'brandnew'))).toBe(false);
  });

  it('快照备份目录 .rollback-<ts> 保留恢复前内容（二段恢复依据，记录命名差异）', () => {
    const dir = tmpDir('qa3-snap-bak-');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'A');
    const snap = createSnapshot(fsPort, dir);
    // 变更后回滚
    fs.writeFileSync(path.join(dir, 'a.txt'), 'CHANGED');
    fs.writeFileSync(path.join(dir, 'extra.txt'), 'E');
    const r = restoreSnapshot(fsPort, snap.snapshot, dir, { stamp: 't1' });
    expect(r.ok).toBe(true);
    expect(r.backupDir).toBe(dir + '.rollback-t1');
    // 备份目录包含变更后的 a.txt 与 extra.txt（可二次恢复）
    expect(fs.readFileSync(path.join(r.backupDir, 'a.txt'), 'utf8')).toBe('CHANGED');
    expect(fs.existsSync(path.join(r.backupDir, 'extra.txt'))).toBe(true);
    // 目录已恢复
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('A');
    expect(fs.existsSync(path.join(dir, 'extra.txt'))).toBe(false);
    // 清理备份目录
    fs.rmSync(r.backupDir, { recursive: true, force: true });
  });

  it('快照文件本身缺失 → 回滚报 ERR_HEAL_ROLLBACK 不静默', () => {
    const dir = tmpDir('qa3-snap-miss-');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'A');
    const snap = createSnapshot(fsPort, dir);
    // 删除快照内的文件再回滚 → 写入恢复（不是报错）；构造"读取失败"场景：目标被目录占位
    const r = restoreSnapshot(fsPort, snap.snapshot, dir);
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('A');
  });

  it('snapshotDigest 对相同内容稳定、对变更敏感', () => {
    const d1 = tmpDir('qa3-snap-digest-');
    fs.writeFileSync(path.join(d1, 'f.txt'), 'content');
    const s1 = createSnapshot(fsPort, d1);
    const d2 = tmpDir('qa3-snap-digest2-');
    fs.writeFileSync(path.join(d2, 'f.txt'), 'content');
    const s2 = createSnapshot(fsPort, d2);
    expect(snapshotDigest(s1.snapshot)).toBe(snapshotDigest(s2.snapshot));
    fs.writeFileSync(path.join(d2, 'f.txt'), 'changed');
    const s3 = createSnapshot(fsPort, d2);
    expect(snapshotDigest(s3.snapshot)).not.toBe(snapshotDigest(s1.snapshot));
  });

  it('createSnapshot 对不存在目录返回空快照（不报错）', () => {
    const snap = createSnapshot(fsPort, path.join(os.tmpdir(), 'qa3-no-such-' + Date.now()));
    expect(snap.ok).toBe(true);
    expect(snap.snapshot.files).toEqual([]);
  });

  it('restoreSnapshot 回滚失败（注入 fs 读错误）→ ERR_HEAL_ROLLBACK', () => {
    const dir = tmpDir('qa3-snap-fail-');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'A');
    const snap = createSnapshot(fsPort, dir);
    // 注入写失败 fs：writeFileSync 抛错
    const badFs = { ...fsPort, writeFileSync: () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; } };
    const r = restoreSnapshot(badFs, snap.snapshot, dir);
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_HEAL_ROLLBACK');
  });
});
