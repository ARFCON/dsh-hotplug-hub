'use strict';
// test/sandbox-cleanup.test.js — N37 沙箱清理 + 快照回滚删除新增文件（QA #3）
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../app/create-core');
const { runPipeline } = require('../app/pipeline');
const { createFsPort } = require('../ports/fs');
const { createSnapshot, restoreSnapshot, cleanupResidue } = require('../infra/snapshot');

const fsPort = createFsPort(fs);

function tempRoots(prefix = 'launcher-n37-') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    base,
    roots: {
      assemblyDir: path.join(base, 'assembly'),
      sandboxRoot: path.join(base, 'sandbox', '.sandbox'),
      profilesRoot: path.join(base, 'profiles'),
      storeRoot: path.join(base, 'store')
    }
  };
}

function writeAssembly(roots, id, plugins) {
  const dir = path.join(roots.assemblyDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'assembly.json'), JSON.stringify({
    hotpack: '1.0', id, name: '示例', version: '1.0.0', plugins
  }));
}

const PLUGIN_A = { id: 'a', name: 'pkg-a', version: '1.0.0', source: { type: 'npm' }, config: {} };
const PLUGIN_B = { id: 'b', name: 'pkg-b', version: '1.0.0', source: { type: 'npm' }, config: {} };

describe('N37 沙箱清理（QA 遗留 P0 回归）', () => {
  it('reassemble 移除插件后，其 node_modules 残留被清理且产物保留', async () => {
    const { roots } = tempRoots();
    writeAssembly(roots, 'example', [PLUGIN_A, PLUGIN_B]);
    const core = createCore({ roots });
    const args = { id: 'example', yes: false, wait: false, timeoutMs: 1000, tail: 50 };

    const r1 = await runPipeline(core, 'assemble', args);
    expect(r1.ok).toBe(true);

    // 制造残留：模拟旧版 install 落地的 node_modules/pkg-b
    const sb = path.join(roots.sandboxRoot, 'example');
    const residue = path.join(sb, 'node_modules', 'pkg-b');
    fs.mkdirSync(residue, { recursive: true });
    fs.writeFileSync(path.join(residue, 'package.json'), '{}');
    expect(fs.existsSync(residue)).toBe(true);

    // 新 assembly 移除 pkg-b
    writeAssembly(roots, 'example', [PLUGIN_A]);
    const r2 = await runPipeline(core, 'assemble', args);
    expect(r2.ok).toBe(true);
    expect(Array.isArray(r2.data.cleaned)).toBe(true);
    expect(r2.data.cleaned.length).toBeGreaterThan(0);

    // 残留被清理
    expect(fs.existsSync(residue)).toBe(false);
    expect(fs.existsSync(path.join(sb, 'node_modules'))).toBe(false);
    // 期望产物保留
    expect(fs.existsSync(path.join(sb, 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(sb, 'cordis.patch.yml'))).toBe(true);
    expect(fs.existsSync(path.join(sb, 'logs'))).toBe(true);
  });

  it('cleanupResidue 越界防护：root 外目标被拒绝', () => {
    const { base, roots } = tempRoots();
    const outside = path.join(base, '..', 'outside-' + Date.now());
    fs.mkdirSync(outside, { recursive: true });
    const r = cleanupResidue(fsPort, outside, { root: roots.sandboxRoot, keep: [] });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_ARG_PATH_ESCAPE');
    expect(fs.existsSync(outside)).toBe(true); // 未被删除
  });

  it('cleanupResidue 保留声明产物、删除其余', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-clean-'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '- insert: []\n');
    fs.mkdirSync(path.join(dir, 'logs'));
    fs.writeFileSync(path.join(dir, 'logs', 'run.jsonl'), 'x\n');
    fs.mkdirSync(path.join(dir, 'node_modules', 'old'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'old', 'package.json'), '{}');
    fs.writeFileSync(path.join(dir, 'stray.tmp'), 'x');

    const r = cleanupResidue(fsPort, dir, { keep: ['package.json', 'cordis.patch.yml'], keepPrefix: ['logs'] });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(dir, 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'cordis.patch.yml'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'logs', 'run.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'node_modules'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'stray.tmp'))).toBe(false);
  });
});

describe('快照回滚删除新增文件（QA #3 回归）', () => {
  it('回滚后快照清单之外的新增文件/目录被删除', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-snap-'));
    fs.writeFileSync(path.join(dir, 'a.txt'), 'A');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'B');
    const snap = createSnapshot(fsPort, dir);
    expect(snap.ok).toBe(true);

    // 新增文件与目录
    fs.writeFileSync(path.join(dir, 'c.txt'), 'C');
    fs.mkdirSync(path.join(dir, 'extra'));
    fs.writeFileSync(path.join(dir, 'extra', 'd.txt'), 'D');

    const r = restoreSnapshot(fsPort, snap.snapshot, dir);
    expect(r.ok).toBe(true);
    // rel 统一为正斜杠（跨平台），故断言 'extra/d.txt' 而非 path.join 拼接
    expect(r.removed).toEqual(expect.arrayContaining(['c.txt', 'extra/d.txt']));
    expect(fs.existsSync(path.join(dir, 'a.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'b.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'c.txt'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'extra'))).toBe(false);
  });
});
