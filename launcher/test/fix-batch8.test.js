'use strict';
// test/fix-batch8.test.js — C6 批（与 fix-batch7 拆分，保持 ≤300 行）验收：
//   FIX-29 .cmd/.bat harness 经 cmd.exe 包装（ComSpec；特殊字符显式拒绝）
//   FIX-30 runlog 超长坏尾（>4096B）seq 跨进程恢复
//   FIX-31 install 失败持久化真实子进程退出码（childExitCode）
//   FIX-32 成功 launch 后 retries 清零 / 失败 pid 置空 / rollback.lastRollbackAt 语义
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { createCore } = require('../app/create-core');
const { createProcPort } = require('../ports/proc');
const { STAGES } = require('../app/stages');
const { launchProcess, wrapCmdScript, isCmdScript } = require('../infra/launch');
const { createRunLog } = require('../infra/runlog');
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
  env.DSH_HOME = home;
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

describe('FIX-29 .cmd/.bat harness 包装（C6）', () => {
  it('wrapCmdScript：/d /c + 无手写引号（libuv 自动包裹），ComSpec 优先', () => {
    expect(isCmdScript('C:\\x\\dsh.cmd')).toBe(true);
    expect(isCmdScript('C:\\x\\dsh.exe')).toBe(false);
    const w = wrapCmdScript('C:\\path with space\\dsh.cmd', ['--profile', 'web'], 'C:\\Windows\\system32\\cmd.exe');
    expect(w.ok).toBe(true);
    expect(w.bin).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(w.args).toEqual(['/d', '/c', 'C:\\path with space\\dsh.cmd', '--profile', 'web']);
  });

  it('wrapCmdScript：cmd 特殊字符显式拒绝（防命令注入/引号破坏）', () => {
    expect(wrapCmdScript('C:\\x\\a&b.cmd', [], 'cmd.exe').ok).toBe(false);
    expect(wrapCmdScript('C:\\x\\dsh.cmd', ['a|b'], 'cmd.exe').ok).toBe(false);
    expect(wrapCmdScript('C:\\x\\dsh.cmd', ['ok'], 'cmd.exe').ok).toBe(true);
  });

  it.skipIf(process.platform !== 'win32')('win32 真实 .cmd spawn 经包装成功退出 0（含空格路径）', async () => {
    const home = tempDir('fix29-');
    const dir = tempDir('fix29-cmd-');
    const script = path.join(dir, 'fake dsh.cmd');
    fs.writeFileSync(script, '@echo off\r\necho HARNESS_OK\r\nexit /b 0\r\n');
    const core = createCore({
      baseDir: ROOT, home, platform: 'win32', env: isolatedEnv(home),
      procPort: createProcPort({ spawn: require('child_process').spawn, spawnSync: require('child_process').spawnSync })
    });
    const r = await launchProcess(core, { harness: script, profile: dir, wait: true, timeoutMs: 15000 });
    expect(r.ok).toBe(true);
    expect(r.result.exitCode).toBe(0);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('FIX-30 runlog 超长坏尾 seq 恢复（C6）', () => {
  it('>4096B 未换行坏尾：新进程 seq 从断点续写，不重复', () => {
    const dir = tempDir('fix30-');
    const logFile = path.join(dir, 'run.jsonl');
    const line1 = JSON.stringify({ seq: 1, t: '2026-01-01T00:00:00.000Z', stream: 'stdout', line: 'a' });
    const line2 = JSON.stringify({ seq: 2, t: '2026-01-01T00:00:00.000Z', stream: 'stdout', line: 'b' });
    fs.writeFileSync(logFile, line1 + '\n' + line2 + '\n' + 'x'.repeat(8192));
    const log = createRunLog(fs, logFile);
    const r = log.append({ stream: 'stdout', line: 'c' });
    expect(r.ok).toBe(true);
    expect(r.seq).toBe(3);
    // 坏尾已被截断：文件以完整行结尾
    const text = fs.readFileSync(logFile, 'utf8');
    expect(text).not.toContain('xxxxx');
    const parsed = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(parsed.map((p) => p.seq)).toEqual([1, 2, 3]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('整文件为单行无换行合法 JSON（无坏尾）→ seq 恢复', () => {
    const dir = tempDir('fix30b-');
    const logFile = path.join(dir, 'run.jsonl');
    fs.writeFileSync(logFile, JSON.stringify({ seq: 9, t: '2026-01-01T00:00:00.000Z', stream: 'stdout', line: 'solo' }));
    const log = createRunLog(fs, logFile);
    const r = log.append({ stream: 'stdout', line: 'next' });
    expect(r.seq).toBe(10);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('FIX-31 install 失败持久化真实子进程退出码（C6）', () => {
  it('stageInstall 失败 → state.install.lastExit 存真实退出码（非契约码）', async () => {
    const home = tempDir('fix31-');
    const core = createCore({
      baseDir: ROOT, home, platform: 'win32', env: isolatedEnv(home),
      procPort: createProcPort({
        spawn: () => { throw new Error('n/a'); },
        spawnSync: () => ({ status: 7, error: null, stderr: 'Error: EACCES: permission denied', stdout: '' })
      })
    });
    const dir = path.join(ROOT, 'assembly', 'fix31');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'assembly.json'), JSON.stringify({
      hotpack: '1.0', id: 'fix31', name: 'q', version: '1.0.0',
      plugins: [{ id: 'a', name: 'pkg-a', version: '1.0.0', source: { type: 'npm' }, config: {} }]
    }, null, 2));
    const state = emptyState('fix31');
    await STAGES.assemble(core, state, { id: 'fix31' });
    state.phase = 'CHECKED';
    const r = await STAGES.install(core, state, { id: 'fix31' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ERR_INSTALL_FAILED');
    expect(state.install.lastExit).toBe(7);
    expect(state.install.status).toBe('failed');
    fs.rmSync(path.join(ROOT, 'assembly', 'fix31'), { recursive: true, force: true });
    fs.rmSync(path.join(ROOT, 'sandbox', '.sandbox', 'fix31'), { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('FIX-32 launch 计数/pid/rollback 语义（C6）', () => {
  function launchCore(home) {
    const hpath = path.join(home, 'AppData', 'Local', 'Programs', 'DSH Desktop', 'DSH Desktop.exe');
    fs.mkdirSync(path.dirname(hpath), { recursive: true });
    fs.writeFileSync(hpath, 'MZ fake harness');
    return createCore({
      baseDir: ROOT, home, platform: 'win32', env: isolatedEnv(home),
      procPort: createProcPort({ spawn: () => fakeChild(), spawnSync: () => ({ status: 1, error: null, stderr: '', stdout: '' }) })
    });
  }

  function seedSandbox(id) {
    const sb = path.join(ROOT, 'sandbox', '.sandbox', id);
    fs.mkdirSync(path.join(sb, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(sb, 'package.json'), JSON.stringify({ name: 'x', version: '0.1.0', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }));
    fs.writeFileSync(path.join(sb, 'cordis.patch.yml'), '- insert: []\n');
    return sb;
  }

  it('成功 launch 后 retries 清零（连续失败语义）', async () => {
    const home = tempDir('fix32a-');
    const core = launchCore(home);
    const sb = seedSandbox('fix32a');
    const state = emptyState('fix32a');
    state.phase = 'INSTALLED';
    state.launch.retries = 5;
    state.launch.lastStart = '2026-08-20T00:00:00.000Z';
    const r = await STAGES.launch(core, state, { id: 'fix32a', wait: false });
    expect(r.ok).toBe(true);
    expect(state.launch.retries).toBe(0);
    expect(state.launch.pid).toBe(7777);
    expect(state.phase).toBe('MONITORING');
    fs.rmSync(sb, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('失败 launch：retries+1、pid 置空、lastExit 存真实退出码', async () => {
    const home = tempDir('fix32b-');
    const core = launchCore(home);
    const sb = seedSandbox('fix32b');
    const state = emptyState('fix32b');
    state.phase = 'INSTALLED';
    state.launch.pid = 111;
    const child = fakeChild();
    core.ports.proc.spawn = () => child;
    const p = STAGES.launch(core, state, { id: 'fix32b', wait: true, timeoutMs: 5000 });
    child.emit('exit', 3, null);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ERR_LAUNCH_EXIT');
    expect(state.launch.retries).toBe(1);
    expect(state.launch.pid).toBeNull();
    expect(state.launch.lastExit).toBe(3);
    fs.rmSync(sb, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('launch 只更新 rollback.snapshot，不篡改 lastRollbackAt', async () => {
    const home = tempDir('fix32c-');
    const core = launchCore(home);
    const sb = seedSandbox('fix32c');
    // 预置 profile 已有旧文件（保证同步前快照非空，回滚有据可依）
    const profileDir = path.join(home, '.dsh', 'profiles', 'fix32c');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'old-file.txt'), 'legacy');
    const state = emptyState('fix32c');
    state.phase = 'INSTALLED';
    state.rollback.lastRollbackAt = '2026-01-01T00:00:00.000Z';
    const r = await STAGES.launch(core, state, { id: 'fix32c', wait: false });
    expect(r.ok).toBe(true);
    expect(state.rollback.lastRollbackAt).toBe('2026-01-01T00:00:00.000Z'); // 未被 launch 改写
    expect(state.rollback.snapshot).not.toBeNull();
    expect(state.rollback.snapshot.files.some((f) => f.rel === 'old-file.txt')).toBe(true);
    fs.rmSync(sb, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
});
