'use strict';
// test/fix-batch7.test.js — C6 批（第七批根治）验收：
//   FIX-26 CRASH_LOOP 自愈闭环（计数重置，不再恒 ERR_HEAL_BUDGET）
//   FIX-27 quarantine 消费（assemble/install/launch 产物排除被隔离插件）
//   FIX-28 path 源真实落地（junction/symlink，非复制壳）
// FIX-29~32（cmd 包装/runlog/install 退出码/launch 语义）见 test/fix-batch8.test.js。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../app/create-core');
const { STAGES } = require('../app/stages');
const { installPathPlugin } = require('../infra/install');
const { validateSourcePath } = require('../domain/ids');
const { tempDir } = require('./helpers');

const ROOT = path.join(__dirname, '..');

function isolatedEnv(home) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  env.HOME = home;
  env.USERPROFILE = home;
  env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
  env.ProgramFiles = path.join(home, 'pf');
  env['ProgramFiles(x86)'] = path.join(home, 'pf86');
  env.PATH = path.join(home, 'bin');
  env.DSH_HOME = path.join(home, '.dsh'); // H-1 语义：DSH_HOME = .dsh 域目录
  return env;
}

function fakeChild(pid = 7777) {
  const c = new EventEmitter();
  c.pid = pid;
  c.stdout = new PassThrough();
  c.stderr = new PassThrough();
  c.unref = () => {};
  c.kill = () => true;
  return c;
}

function emptyState(id) {
  return {
    schemaVersion: 1, id, assemblySha256: null, phase: 'IDLE',
    resolved: { plugins: [], conflicts: [], pinnedAt: null },
    install: { status: 'missing', lastExit: null, nodeModules: false },
    launch: { lastExit: null, lastStart: null, retries: 0, pid: null },
    heal: { history: [], quarantined: [] },
    rollback: { snapshot: null, lastRollbackAt: null }
  };
}

describe('FIX-26 CRASH_LOOP 自愈闭环（C6）', () => {
  it('补救步骤成功 → lastExit/retries 重置 → runHeal verified:true', async () => {
    const core = createCore({ baseDir: ROOT, home: os.tmpdir(), env: isolatedEnv(os.tmpdir()) });
    const profile = tempDir();
    const state = { launch: { lastExit: 1, retries: 3 }, heal: { history: [], quarantined: [] } };
    const action = { code: 'CRASH_LOOP', steps: [{ type: 'quarantine' }], budget: 2, rollback: '恢复被禁用插件' };
    const { runHeal } = require('../infra/heal');
    const r = await runHeal(core, [action], {
      state, profile, plugins: [{ name: 'pkg-bad' }],
      quarantine: () => {
        state.heal.quarantined = ['pkg-bad'];
        return { ok: true };
      }
    }, { dryRun: false });
    expect(r.ok).toBe(true);
    expect(r.result.history[0].verified).toBe(true);
    expect(state.launch.lastExit).toBeNull();
    expect(state.launch.retries).toBe(0);
    fs.rmSync(profile, { recursive: true, force: true });
  });

  it('空 steps 的退化动作不重置计数（未补救不得宣称 fresh start）', async () => {
    const core = createCore({ baseDir: ROOT, home: os.tmpdir(), env: isolatedEnv(os.tmpdir()) });
    const state = { launch: { lastExit: 1, retries: 3 }, heal: { history: [], quarantined: [] } };
    const { executeAction } = require('../infra/heal');
    await executeAction(core, { code: 'CRASH_LOOP', steps: [] }, { state, profile: tempDir(), plugins: [] });
    expect(state.launch.lastExit).toBe(1); // 未重置
    expect(state.launch.retries).toBe(3);
  });
});

describe('FIX-27 quarantine 消费（C6）', () => {
  function qCore(home) {
    return createCore({ baseDir: ROOT, home, platform: 'win32', env: isolatedEnv(home) });
  }

  it('assemble 产物排除被隔离插件（resolved/manifest/bundles/patch/steps）', async () => {
    const home = tempDir('fix27a-');
    const core = qCore(home);
    const dir = path.join(ROOT, 'assembly', 'fix27a');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'assembly.json'), JSON.stringify({
      hotpack: '1.0', id: 'fix27a', name: 'q', version: '1.0.0',
      plugins: [
        { id: 'a', name: 'pkg-a', version: '1.0.0', source: { type: 'npm' }, config: {} },
        { id: 'b', name: 'pkg-b', version: '2.0.0', source: { type: 'npm' }, config: { 'dsh.bundle.patch': true } }
      ]
    }, null, 2));
    const state = emptyState('fix27a');
    state.heal.quarantined = ['pkg-b'];
    const r = await STAGES.assemble(core, state, { id: 'fix27a' });
    expect(r.ok).toBe(true);
    expect(r.data.excluded).toEqual(['pkg-b']);
    expect(state.resolved.plugins.map((p) => p.name)).toEqual(['pkg-a']);
    const sb = path.join(ROOT, 'sandbox', '.sandbox', 'fix27a');
    const manifest = JSON.parse(fs.readFileSync(path.join(sb, 'package.json'), 'utf8'));
    expect(Object.keys(manifest.dependencies)).toEqual(['pkg-a']);
    expect(manifest.dsh.profile.bundles).toEqual([]);
    expect(fs.readFileSync(path.join(sb, 'cordis.patch.yml'), 'utf8')).not.toContain('pkg-b');
    fs.rmSync(path.join(ROOT, 'assembly', 'fix27a'), { recursive: true, force: true });
    fs.rmSync(sb, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('launch 同步（syncProfile exclude）后 profile 产物排除被隔离插件', async () => {
    const home = tempDir('fix27b-');
    const core = qCore(home);
    const sb = path.join(ROOT, 'sandbox', '.sandbox', 'fix27b');
    fs.mkdirSync(path.join(sb, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(sb, 'package.json'), JSON.stringify({
      name: 'x', version: '0.1.0', private: true,
      dependencies: { 'pkg-a': '^1.0.0', 'pkg-b': '^2.0.0' },
      dsh: { profile: { bundles: ['pkg-b'] } }
    }));
    const YAML = require('yaml');
    fs.writeFileSync(path.join(sb, 'cordis.patch.yml'), YAML.stringify([
      { insert: [{ id: 'hp-x-a', name: 'pkg-a', config: {} }, { id: 'hp-x-b', name: 'pkg-b', config: {} }] }
    ]));
    const sync = core.infra.profile.syncProfile(core, 'fix27b', { requireHarness: false, exclude: ['pkg-b'] });
    expect(sync.ok).toBe(true);
    const profileDir = path.join(home, '.dsh', 'profiles', 'fix27b');
    const pkg = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
    expect(Object.keys(pkg.dependencies)).toEqual(['pkg-a']);
    expect(pkg.dsh.profile.bundles).toEqual([]);
    const patchText = fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8');
    expect(patchText).not.toContain('pkg-b');
    expect(patchText).toContain('pkg-a');
    fs.rmSync(sb, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('install 跳过被隔离插件', async () => {
    const home = tempDir('fix27c-');
    const core = qCore(home);
    const sb = path.join(ROOT, 'sandbox', '.sandbox', 'fix27c');
    fs.mkdirSync(sb, { recursive: true });
    const state = emptyState('fix27c');
    state.phase = 'CHECKED';
    state.resolved = {
      plugins: [
        { id: 'a', name: 'pkg-a', source: { type: 'path', path: tempDir('fix27c-src-') }, installPath: tempDir('fix27c-src2-') },
        { id: 'b', name: 'pkg-b', source: { type: 'path', path: tempDir('fix27c-src3-') }, installPath: tempDir('fix27c-src4-') }
      ],
      conflicts: [], pinnedAt: null
    };
    state.heal.quarantined = ['pkg-b'];
    // 两个 path 源目标目录真实存在
    const targets = [state.resolved.plugins[0].installPath, state.resolved.plugins[1].installPath];
    for (const t of targets) {
      fs.mkdirSync(t, { recursive: true });
      fs.writeFileSync(path.join(t, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }));
    }
    const r = await STAGES.install(core, state, { id: 'fix27c' });
    expect(r.ok).toBe(true);
    expect(r.data.excluded).toEqual(['pkg-b']);
    expect(fs.existsSync(path.join(sb, 'node_modules', 'pkg-a'))).toBe(true);
    expect(fs.existsSync(path.join(sb, 'node_modules', 'pkg-b'))).toBe(false);
    fs.rmSync(sb, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('FIX-28 path 源真实落地（C6）', () => {
  it('installPathPlugin 建立 junction/symlink，插件代码可读（非复制壳）', () => {
    const home = tempDir('fix28-');
    const core = createCore({ baseDir: ROOT, home, platform: 'win32', env: isolatedEnv(home) });
    const target = path.join(home, 'src', 'pkg-p');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name: 'pkg-p', version: '1.0.0', main: 'index.js' }));
    fs.writeFileSync(path.join(target, 'index.js'), 'module.exports = 42;\n');
    const profile = tempDir('fix28-profile-');
    const r = installPathPlugin(core, { name: 'pkg-p', source: { type: 'path', path: target }, installPath: target }, profile);
    expect(r.ok).toBe(true);
    const nm = path.join(profile, 'node_modules', 'pkg-p');
    expect(fs.lstatSync(nm).isSymbolicLink()).toBe(true); // junction/symlink
    expect(fs.readFileSync(path.join(nm, 'index.js'), 'utf8')).toContain('42'); // 代码真实可读
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(profile, { recursive: true, force: true });
  });

  it('validateSourcePath 拒绝相对路径（CWD 漂移根因），接受跨平台绝对路径', () => {
    expect(validateSourcePath('src/foo').ok).toBe(false);
    expect(validateSourcePath('../x').ok).toBe(false);
    expect(validateSourcePath('C:/src/b').ok).toBe(true);   // win 盘符（POSIX 也认）
    expect(validateSourcePath('C:\\src\\b').ok).toBe(true);  // win 反斜杠
    expect(validateSourcePath('/home/x').ok).toBe(true);     // POSIX 绝对（win 也认）
    expect(validateSourcePath('//attacker/share').ok).toBe(false); // UNC 仍拒
  });
});
