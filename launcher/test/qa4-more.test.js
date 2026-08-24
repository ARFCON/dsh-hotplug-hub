'use strict';
// test/qa4-more.test.js — QA4 第三批：剩余分支补测
// pipeline 锁失败 / lock owner 损坏回退 / dsh-cli 三优先级 / pipeChildToLog 回调 /
// heal-steps pin-compatible / heal-verify rollback 特判 / runlog 空条目 / stageLaunch harness 失败。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { createCore } = require('../app/create-core');
const { createFsPort } = require('../ports/fs');
const { createProcPort } = require('../ports/proc');
const { runPipeline } = require('../app/pipeline');
const { readToken } = require('../infra/lock');
const { findDshCli } = require('../infra/dsh-cli');
const { pipeChildToLog, createLineDecoder } = require('../infra/monitor');
const { createRunLog } = require('../infra/runlog');
const { executeAction } = require('../infra/heal');
const { rollbackAction } = require('../infra/heal-verify');
const { tempDir, isolatedEnv } = require('./helpers');

const ROOT = path.join(__dirname, '..');

function isolatedRoots(home) {
  return {
    assemblyDir: path.join(home, 'assembly'),
    sandboxRoot: path.join(home, 'sandbox'),
    profilesRoot: path.join(home, '.dsh', 'profiles'),
    storeRoot: path.join(home, '.dsh', 'hotplug-store')
  };
}

describe('QA4 pipeline（锁失败路径）', () => {
  it('acquireLock 失败（openSync wx EACCES）→ ERR_LOCK_ACQUIRE 而非崩溃', async () => {
    const home = tempDir('qa4p1-');
    const realFs = createFsPort(fs);
    const failingFs = {
      ...realFs,
      openSync: (p, ...rest) => {
        if (String(p).endsWith('.lock')) { const e = new Error('EACCES: lock'); e.code = 'EACCES'; throw e; }
        return fs.openSync(p, ...rest);
      }
    };
    const core = createCore({
      baseDir: ROOT, home, platform: 'win32', env: isolatedEnv(home),
      fsPort: failingFs, roots: isolatedRoots(home)
    });
    const r = await runPipeline(core, 'assemble', { id: 'demo' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ERR_LOCK_ACQUIRE');
    expect(r.exitCode).toBe(10);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('只读命令（check）不持锁：锁目录已存在也不阻塞', async () => {
    const home = tempDir('qa4p2-');
    const core = createCore({ baseDir: ROOT, home, platform: 'win32', env: isolatedEnv(home), roots: isolatedRoots(home) });
    // 预置一个他人持有的锁（只读命令不应碰它）
    const lockDir = path.join(home, '.dsh', 'hotplug-store', 'demo', '.lock');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, 'owner'), JSON.stringify({ owner: 'pid-999', at: Date.now() }));
    const r = await runPipeline(core, 'status', { id: 'demo' });
    expect(r.ok).toBe(true); // 只读命令无视锁
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('QA4 lock（token 损坏回退）', () => {
  it('readToken 对损坏/缺失文件返回 null', () => {
    const dir = tempDir('qa4lk-');
    const lockPath = path.join(dir, '.lock');
    expect(readToken(createFsPort(fs), lockPath)).toBeNull();
    fs.writeFileSync(lockPath, 'garbage', 'utf8');
    expect(readToken(createFsPort(fs), lockPath)).toBeNull();
    fs.writeFileSync(lockPath, '123\nnot-a-number\n', 'utf8');
    expect(readToken(createFsPort(fs), lockPath)).toBeNull();
    fs.writeFileSync(lockPath, '123\n456\n', 'utf8');
    expect(readToken(createFsPort(fs), lockPath)).toEqual({ pid: 123, at: 456 });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('QA4 dsh-cli（三优先级探测）', () => {
  it('优先 Desktop 内置 bin.js；其次 ~/.dsh；最后 PATH（win32 cmd /c）', () => {
    const home = tempDir('qa4d1-');
    const core = createCore({
      baseDir: ROOT, home, platform: 'win32',
      env: isolatedEnv(home), roots: isolatedRoots(home)
    });
    // 1) Desktop 内置（isolatedEnv 的 LOCALAPPDATA=home → builtin 在 home/Programs/...）
    const builtin = path.join(home, 'Programs', 'DSH Desktop', 'resources', 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    fs.mkdirSync(path.dirname(builtin), { recursive: true });
    fs.writeFileSync(builtin, '// bin');
    let r = findDshCli(core, { profile: 'web' });
    expect(r.ok).toBe(true);
    expect(r.bin).toBe(process.execPath);
    expect(r.args[0]).toBe(builtin);
    expect(r.args).toContain('web');
    // 2) ~/.dsh 内置（删 Desktop 后）
    fs.rmSync(path.dirname(path.dirname(builtin)), { recursive: true, force: true });
    const alt = path.join(home, '.dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    fs.mkdirSync(path.dirname(alt), { recursive: true });
    fs.writeFileSync(alt, '// alt');
    r = findDshCli(core, { profile: 'demo' });
    expect(r.ok).toBe(true);
    expect(r.args[0]).toBe(alt);
    // 3) PATH 回退（win32 cmd /c；R3：解释器解析为 ComSpec/System32 绝对路径，
    //    仅在宿主无 ComSpec/SystemRoot 的极端环境回落裸 'cmd.exe'——CI POSIX 宿主即如此）
    fs.rmSync(path.join(home, '.dsh'), { recursive: true, force: true });
    r = findDshCli(core, { profile: 'demo' });
    expect(r.ok).toBe(true);
    expect(
      r.bin === 'cmd.exe' ||
      (path.isAbsolute(r.bin) && path.basename(r.bin).toLowerCase() === 'cmd.exe')
    ).toBe(true);
    expect(r.args).toEqual(['/c', 'dsh', 'plugin', '--profile', 'demo', 'add']);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('win32 特殊字符 profile 拒绝（防 cmd 注入）', () => {
    const home = tempDir('qa4d2-');
    const core = createCore({ baseDir: ROOT, home, platform: 'win32', env: isolatedEnv(home), roots: isolatedRoots(home) });
    const r = findDshCli(core, { profile: 'x&y' });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_ARG_BAD_OPTION');
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('QA4 monitor.pipeChildToLog（回调与失败传递）', () => {
  it('onLine 收到行与 append 失败错误', async () => {
    const dir = tempDir('qa4m1-');
    const realFs = createFsPort(fs);
    let appendCalls = 0;
    const failingFs = {
      ...realFs,
      appendFileSync: (...a) => {
        appendCalls += 1;
        if (appendCalls >= 3) { const e = new Error('ENOSPC'); e.code = 'ENOSPC'; throw e; }
        return fs.appendFileSync(...a);
      }
    };
    const log = createRunLog(failingFs, path.join(dir, 'run.jsonl'), { now: Date.now });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const lines = [];
    pipeChildToLog(child, log, { onLine: (stream, line) => lines.push(`${stream}:${line}`) });
    child.stdout.write('hello\n');
    child.stderr.write('oops\n');
    child.stdout.write('third\n');
    child.stderr.end();
    child.stdout.end();
    await new Promise((r) => setTimeout(r, 50));
    expect(lines).toContain('stdout:hello');
    expect(lines).toContain('stderr:oops');
    // 第 3 次 append 失败 → onLine('error', ...) 收到错误消息
    expect(lines.some((l) => l.startsWith('error:') && l.includes('ENOSPC'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('QA4 heal-steps / heal-verify（分支补测）', () => {
  it('pin-compatible：重新解析失败 → 显式错误（不静默 ok）', async () => {
    const home = tempDir('qa4h1-');
    const core = createCore({
      baseDir: ROOT, home, platform: 'win32', env: isolatedEnv(home), roots: isolatedRoots(home),
      // registry 有数据但无满足 ^1.0.0 的版本 → resolvePlugins 返回 error
      registryPort: { availableVersions: () => ['2.0.0'] }
    });
    const ctx = {
      state: { id: 'demo', launch: {} },
      profile: tempDir('qa4h1p-'),
      plugins: [{ id: 'a', name: 'pkg-a', source: { type: 'npm' }, version: '^1.0.0', resolvedVersion: null, config: {} }],
      pack: { id: 'demo', plugins: [{ id: 'a', name: 'pkg-a', source: { type: 'npm' }, version: '^1.0.0', config: {} }] }
    };
    const r = await executeAction(core, { code: 'VERSION_CONFLICT', steps: [{ type: 'pin-compatible' }] }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_INSTALL_ACQUIRE');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('rollbackAction：特判"恢复原 bundles 列表"文案时不恢复快照', async () => {
    const core = createCore({ baseDir: ROOT, home: os.tmpdir(), platform: 'win32', env: isolatedEnv(os.tmpdir()) });
    let restored = false;
    const ctx = {
      state: { rollback: { snapshot: { dir: 'x', files: [] } } },
      profile: tempDir('qa4h2-')
    };
    // 注入 restoreSnapshot 跟踪（经 core.infra.snapshot 替换）
    const orig = core.infra.snapshot.restoreSnapshot;
    core.infra.snapshot.restoreSnapshot = (...a) => { restored = true; return orig(...a); };
    const r = await rollbackAction(core, { code: 'BUNDLE_MISCLASSIFY', rollback: '恢复原 bundles 列表' }, ctx);
    expect(r.ok).toBe(true);
    expect(restored).toBe(false); // 特判：不恢复
    fs.rmSync(ctx.profile, { recursive: true, force: true });
  });
});

describe('QA4 runlog（空条目与长行）', () => {
  it('append 空 entry：line undefined → 空字符串，stream 默认 stdout', () => {
    const dir = tempDir('qa4r1-');
    const log = createRunLog(createFsPort(fs), path.join(dir, 'run.jsonl'), { now: Date.now });
    const r = log.append({});
    expect(r.ok).toBe(true);
    const all = log.list();
    expect(all).toHaveLength(1);
    expect(all[0].line).toBe('');
    expect(all[0].stream).toBe('stdout');
    expect(all[0].seq).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('QA4 stageLaunch（harness 校验失败前置）', () => {
  it('harness 缺失 → ERR_HARNESS_NOT_FOUND（先校验后同步副作用）', async () => {
    const home = tempDir('qa4s1-');
    const core = createCore({
      baseDir: ROOT, home, platform: 'win32',
      env: isolatedEnv(home), roots: isolatedRoots(home),
      // probe 用注入的 procPort（spawnSync 不带 env → 进程内单测会继承真实 PATH，
      // 可能命中真实 dsh.cmd；注入失败端口保证隔离确定性）
      procPort: createProcPort({
        spawn: () => { throw new Error('n/a'); },
        spawnSync: () => ({ status: 1, error: null, stderr: '', stdout: '' })
      })
    });
    // 预写 state：phase=INSTALLED（launch 状态机前置通过，harness 校验成为首个拦截点）
    const stateFile = path.join(home, '.dsh', 'hotplug-store', 'demo', 'state.json');
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({
      schemaVersion: 1, id: 'demo', assemblySha256: null, phase: 'INSTALLED',
      resolved: { plugins: [], conflicts: [], pinnedAt: null },
      install: { status: 'ok', lastExit: 0, nodeModules: false },
      launch: { lastExit: null, lastStart: null, retries: 0, pid: null },
      heal: { history: [], quarantined: [] },
      rollback: { snapshot: null, lastRollbackAt: null }
    }));
    const r = await runPipeline(core, 'launch', { id: 'demo', wait: true });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ERR_HARNESS_NOT_FOUND');
    // 零副作用：无 profile 生成（harness 校验先于 syncProfile）
    expect(fs.existsSync(path.join(home, '.dsh', 'profiles', 'demo'))).toBe(false);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('QA4 createLineDecoder（hasPending 边界）', () => {
  it('半行后 hasPending=true；flush 后 false', () => {
    const d = createLineDecoder();
    expect(d.hasPending()).toBe(false);
    d.push('abc');
    expect(d.hasPending()).toBe(true);
    d.push('\n');
    expect(d.hasPending()).toBe(false);
  });
});
