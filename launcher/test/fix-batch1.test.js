'use strict';
// test/fix-batch1.test.js — FIX-1~5 验收（数据正确性）
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { createCore } = require('../app/create-core');
const { createProcPort } = require('../ports/proc');
const { runPipeline } = require('../app/pipeline');
const { createFsPort } = require('../ports/fs');
const { createSnapshot, restoreSnapshot } = require('../infra/snapshot');
const { syncProfile } = require('../infra/profile');

const fsPort = createFsPort(fs);

function tempRoots(prefix = 'fix1-') {
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

function fakeChild(pid = 4242) {
  const c = new EventEmitter();
  c.pid = pid;
  c.stdout = new PassThrough();
  c.stderr = new PassThrough();
  c.unref = () => {};
  return c;
}

function coreWith(roots, extra = {}) {
  // 隔离红线（P5）：home 必须注入——否则 createCore 回退 resolveDshRoot(env).home
  // （真实主目录），findHarness 会探测真实 ~/.dsh：本机有 DSH 时测试"假绿"、
  // CI 无 DSH 时 launch 前置失败（ERR_HARNESS_NOT_FOUND，retries/快照/logWarnings
  // 全部不生效）。在隔离 home 的候选路径放置假 harness（verifyHarness：存在 +
  // 普通文件 + 体积>0 + 非符号链接），launch 全链路在临时目录内自给自足。
  const home = path.dirname(roots.storeRoot); // tempRoots: storeRoot = <base>/store
  const harnessPath = process.platform === 'win32'
    ? path.join(home, 'AppData', 'Local', 'Programs', 'DSH Desktop', 'DSH Desktop.exe')
    : process.platform === 'darwin'
      ? path.join(home, 'Applications', 'DSH Desktop.app', 'Contents', 'MacOS', 'DSH Desktop')
      : path.join(home, '.local', 'bin', 'dsh')
  fs.mkdirSync(path.dirname(harnessPath), { recursive: true })
  fs.writeFileSync(harnessPath, 'fake-harness') // 非空普通文件
  // 注入式夹具（v5 阶段 2）：harness 探测经 dshPort 注入，不再 monkey-patch core.infra。
  // env 同样隔离 LOCALAPPDATA：Windows 候选1 = LOCALAPPDATA\Programs\DSH Desktop\...
  // 若指向真实目录可能命中本机真实 DSH 桌面端（假绿）——隔离后候选全部收敛到
  // 隔离 home 内，测试完全自足。
  return createCore({
    roots,
    home,
    env: { ...process.env, LOCALAPPDATA: path.join(home, 'AppData', 'Local') },
    procPort: createProcPort({ spawn: extra.spawn || (() => { throw new Error('no spawn'); }), spawnSync: () => ({ status: 0, error: null, stderr: '', stdout: '' }) }),
    dshPort: { findHarness: () => ({ ok: true, harness: harnessPath }), verifyHarness: () => ({ ok: true }), pluginAdd: async () => ({ ok: false }), isInstalled: () => false }
  });
}

const PLUGIN_A = { id: 'a', name: 'pkg-a', version: '1.0.0', source: { type: 'npm' }, config: {} };

// 用 path 源插件：install 真实落地 node_modules/pkg-p（避免 npm 假成功但无产物的场景）
function pathPlugin(base) {
  const fakePlugin = path.join(base, 'fake-plugins', 'pkg-p');
  fs.mkdirSync(fakePlugin, { recursive: true });
  fs.writeFileSync(path.join(fakePlugin, 'package.json'), JSON.stringify({ name: 'pkg-p', version: '1.0.0' }));
  return { id: 'p', name: 'pkg-p', source: { type: 'path', path: fakePlugin }, config: {} };
}

describe('FIX-1 install↔sync 断链：profile/node_modules junction', () => {
  it('sandbox 有 node_modules 时同步后 profile/node_modules 可访问已装插件', () => {
    const { roots } = tempRoots();
    const core = coreWith(roots);
    const sb = path.join(roots.sandboxRoot, 'example');
    fs.mkdirSync(path.join(sb, 'node_modules', 'pkg-a'), { recursive: true });
    fs.writeFileSync(path.join(sb, 'package.json'), JSON.stringify({ name: 'dsh-launcher-example' }));
    fs.writeFileSync(path.join(sb, 'node_modules', 'pkg-a', 'index.js'), 'module.exports=1;');
    const r = syncProfile(core, 'example', { requireHarness: false });
    expect(r.ok).toBe(true);
    const profileNm = path.join(roots.profilesRoot, 'example', 'node_modules');
    expect(fs.existsSync(profileNm)).toBe(true);
    expect(fs.existsSync(path.join(profileNm, 'pkg-a', 'index.js'))).toBe(true);
  });

  it('sandbox 无 node_modules 时同步成功且不建空链接', () => {
    const { roots } = tempRoots();
    const core = coreWith(roots);
    const sb = path.join(roots.sandboxRoot, 'example');
    fs.mkdirSync(sb, { recursive: true });
    fs.writeFileSync(path.join(sb, 'package.json'), JSON.stringify({ name: 'dsh-launcher-example' }));
    const r = syncProfile(core, 'example', { requireHarness: false });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(roots.profilesRoot, 'example', 'node_modules'))).toBe(false);
  });
});

describe('FIX-2 rollback 快照时点 = 同步前', () => {
  it('profile 有旧文件 → launch → 修改 → rollback 恢复为 launch 前内容', async () => {
    const { base, roots } = tempRoots();
    writeAssembly(roots, 'example', [pathPlugin(base)]);
    const core = coreWith(roots, { spawn: () => { const c = fakeChild(); return c; } });
    const args = { id: 'example', yes: false, wait: false, timeoutMs: 1000, tail: 50 };
    await runPipeline(core, 'assemble', args);
    // 旧 profile 文件（launch 前）
    const profileDir = path.join(roots.profilesRoot, 'example');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'old-config.json'), '{"v":"old"}');
    // install（path 源真实落地 → phase=INSTALLED）
    const inst = await runPipeline(core, 'install', args);
    expect(inst.ok).toBe(true);
    // launch（detach：fake child 500ms 存活确认）
    const l = await runPipeline(core, 'launch', args);
    expect(l.ok).toBe(true);
    // launch 后修改 profile
    fs.writeFileSync(path.join(profileDir, 'old-config.json'), '{"v":"MUTATED"}');
    // rollback
    const rb = await runPipeline(core, 'rollback', args);
    expect(rb.ok).toBe(true);
    expect(fs.readFileSync(path.join(profileDir, 'old-config.json'), 'utf8')).toBe('{"v":"old"}');
  });
});

describe('FIX-3 restoreSnapshot rel 越界防护', () => {
  it('篡改 rel=../../evil 被拒且无越界写', () => {
    const { base, roots } = tempRoots();
    const dir = path.join(roots.profilesRoot, 'example');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'K');
    const evilRel = path.join('..', '..', 'evil-fix3.txt').replace(/\\/g, '/');
    const snap = { dir, createdAt: 'x', files: [{ rel: evilRel, hash: 'x', content: 'PWNED', size: 5 }] };
    const r = restoreSnapshot(fsPort, snap, dir);
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_ARG_PATH_ESCAPE');
    const escaped = path.join(base, 'evil-fix3.txt');
    expect(fs.existsSync(escaped)).toBe(false); // 无越界写
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('哈希校验失败时删除已写入目标', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix3-hash-'));
    fs.writeFileSync(path.join(dir, 'a.txt'), 'AAA');
    const snap = createSnapshot(fsPort, dir);
    expect(snap.ok).toBe(true);
    // 修改快照内容模拟篡改：content 与 hash 不一致
    const tampered = JSON.parse(JSON.stringify(snap.snapshot));
    tampered.files[0].content = 'BBB'; // hash 仍为 AAA 的 hash
    const r = restoreSnapshot(fsPort, tampered, dir);
    expect(r.ok).toBe(false);
    expect(r.error.message).toContain('哈希不匹配');
    expect(fs.existsSync(path.join(dir, 'a.txt'))).toBe(false); // 已删除（脏数据不落盘）
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('FIX-4 失败路径 state 持久化', () => {
  it('launch 连续失败 3 次后 state.launch.retries===3', async () => {
    const { base, roots } = tempRoots();
    writeAssembly(roots, 'example', [pathPlugin(base)]);
    const core = coreWith(roots, { spawn: () => { throw new Error('spawn ENOENT'); } });
    const args = { id: 'example', yes: false, wait: false, timeoutMs: 1000, tail: 50 };
    await runPipeline(core, 'assemble', args);
    const inst = await runPipeline(core, 'install', args);
    expect(inst.ok).toBe(true);
    for (let i = 0; i < 3; i += 1) {
      const r = await runPipeline(core, 'launch', args);
      expect(r.ok).toBe(false);
    }
    const stateFile = path.join(roots.storeRoot, 'example', 'state.json');
    const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(st.launch.retries).toBe(3);
  });
});

describe('FIX-5 大文件快照回滚恢复', () => {
  it('>1MB 文件修改后 rollback 内容恢复一致', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix5-big-'));
    const big = Buffer.alloc(1500 * 1024, 0x61); // ~1.5MB 'a'
    fs.writeFileSync(path.join(dir, 'big.bin'), big);
    const snap = createSnapshot(fsPort, dir);
    expect(snap.ok).toBe(true);
    expect(snap.snapshot.files[0].external).toBe(true); // 大文件标记 external
    expect(snap.snapshot.externalDir).toBeTruthy();
    // 修改
    fs.writeFileSync(path.join(dir, 'big.bin'), Buffer.alloc(1500 * 1024, 0x62)); // 'b'
    const r = restoreSnapshot(fsPort, snap.snapshot, dir);
    expect(r.ok).toBe(true);
    const restored = fs.readFileSync(path.join(dir, 'big.bin'));
    expect(restored.length).toBe(big.length);
    expect(restored.equals(big)).toBe(true); // 内容恢复为快照时内容
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
