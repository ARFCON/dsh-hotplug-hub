'use strict';
// test/fix-batch3.test.js — FIX-10~14 验收（进程与安全）
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createCore } = require('../app/create-core');
const { createProcPort } = require('../ports/proc');
const { createFsPort } = require('../ports/fs');
const { acquireLock, releaseLock } = require('../infra/lock');
const { findHarness } = require('../infra/harness');
const { createLineDecoder, pipeChildToLog } = require('../infra/monitor');
const { parseHotpack } = require('../domain/assembly');
const { createRunLog } = require('../infra/runlog');

const fsPort = createFsPort(fs);

describe('FIX-10 锁 TOCTOU 二次确认 + release owner 校验', () => {
  it('release 他人锁被拒，释放自己锁成功', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix10-'));
    const lockPath = path.join(dir, '.lock');
    const a = acquireLock(fsPort, lockPath, { waitMs: 500, staleMs: 60000, owner: 'alice' });
    expect(a.ok).toBe(true);
    const wrong = releaseLock(fsPort, lockPath, { owner: 'bob' });
    expect(wrong.ok).toBe(false); // 拒绝释放他人锁
    expect(fs.existsSync(lockPath)).toBe(true); // 锁仍在
    const right = releaseLock(fsPort, lockPath, { owner: 'alice' });
    expect(right.ok).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('接管前二次确认：owner 被更新后放弃接管（等待而非抢锁）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix10b-'));
    const lockPath = path.join(dir, '.lock');
    fs.mkdirSync(lockPath, { recursive: false });
    // 旧 owner 已过期
    fs.writeFileSync(path.join(lockPath, 'owner'), JSON.stringify({ owner: 'pid-old', at: new Date(Date.now() - 60000).toISOString() }));
    // 模拟另一进程在 stale 判定后、接管前更新了 owner（TOCTOU 窗口）
    const r = acquireLock(fsPort, lockPath, {
      waitMs: 200, staleMs: 1000, owner: 'newcomer',
      now: () => Date.now()
    });
    // 由于 owner 已被"别人"在 recheck 时更新为未过期，应等待超时而非抢锁
    // 此处构造：acquireLock 内部 recheck 读到的仍是旧 owner（无法注入中间更新），
    // 因此该用例验证"recheck 存在且未过期则继续等待"的代码路径：直接构造新 owner 后调用
    // —— 通过先手动更新 owner 文件再 acquire（未过期）验证等待超时
    fs.writeFileSync(path.join(lockPath, 'owner'), JSON.stringify({ owner: 'pid-holder', at: new Date().toISOString() }));
    const r2 = acquireLock(fsPort, lockPath, { waitMs: 150, staleMs: 60000, owner: 'newcomer' });
    expect(r2.ok).toBe(false); // 未过期锁 → 等待超时（不抢锁）
    expect(r2.error.code).toBe('ERR_LOCK_ACQUIRE');
    releaseLock(fsPort, lockPath, { owner: 'pid-holder' });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('FIX-11 findHarness 候选循环 + CLI 探测', () => {
  function winCore(env, procImpl) {
    return createCore({
      platform: 'win32',
      env,
      home: os.tmpdir(),
      fsPort,
      procPort: createProcPort({ spawn: () => { throw new Error('n/a'); }, spawnSync: procImpl || (() => ({ status: 1, stdout: '', error: null })) })
    });
  }

  it('候选1损坏（size 0）→ continue 命中候选2', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fix11-'));
    const local = path.join(base, 'local');
    const pf = path.join(base, 'pf');
    fs.mkdirSync(path.join(local, 'Programs', 'DSH Desktop'), { recursive: true });
    fs.mkdirSync(path.join(pf, 'DSH Desktop'), { recursive: true });
    fs.writeFileSync(path.join(local, 'Programs', 'DSH Desktop', 'DSH Desktop.exe'), ''); // 坏：size 0
    fs.writeFileSync(path.join(pf, 'DSH Desktop', 'DSH Desktop.exe'), 'MZ...'); // 好
    const core = winCore({ LOCALAPPDATA: local, ProgramFiles: pf, 'ProgramFiles(x86)': path.join(base, 'pf86') });
    const r = findHarness(core);
    expect(r.ok).toBe(true);
    expect(r.harness).toBe(path.join(pf, 'DSH Desktop', 'DSH Desktop.exe'));
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('候选全缺 + PATH 有 dsh → CLI 回退成功（回退结果必须过 verifyHarness，A2 修复）', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fix11b-'));
    const cliPath = path.join(base, 'tools', 'dsh.cmd');
    fs.mkdirSync(path.dirname(cliPath), { recursive: true });
    fs.writeFileSync(cliPath, '@echo off\r\n'); // 真实文件（size>0、非符号链接）
    const core = winCore({ LOCALAPPDATA: path.join(base, 'nope'), ProgramFiles: path.join(base, 'nope'), 'ProgramFiles(x86)': path.join(base, 'nope') },
      () => ({ status: 0, stdout: cliPath + '\n', stderr: '', error: null }));
    const r = findHarness(core);
    expect(r.ok).toBe(true);
    expect(r.harness).toBe(cliPath);
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('CLI 回退路径不存在/零字节 → 拒绝（ERR_HARNESS_NOT_FOUND，N44 缺口修复）', () => {
    const core = winCore({ LOCALAPPDATA: path.join(os.tmpdir(), 'nope-' + Date.now()), ProgramFiles: 'C:\\nope', 'ProgramFiles(x86)': 'C:\\nope' },
      () => ({ status: 0, stdout: 'C:\\tools\\missing-dsh.cmd\n', stderr: '', error: null }));
    const r = findHarness(core);
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_HARNESS_NOT_FOUND');
  });

  it('probe:false 时不产生 spawn（status 只读命令零子进程，A2 修复）', () => {
    let spawnCalls = 0;
    const core = winCore({ LOCALAPPDATA: path.join(os.tmpdir(), 'nope-' + Date.now()), ProgramFiles: 'C:\\nope', 'ProgramFiles(x86)': 'C:\\nope' },
      () => { spawnCalls += 1; return { status: 0, stdout: 'C:\\tools\\dsh.cmd\n', stderr: '', error: null }; });
    const r = findHarness(core, { probe: false });
    expect(spawnCalls).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_HARNESS_NOT_FOUND');
  });

  it('候选全缺 + PATH 无 dsh → ERR_HARNESS_NOT_FOUND', () => {
    const core = winCore({ LOCALAPPDATA: path.join(os.tmpdir(), 'nope-' + Date.now()), ProgramFiles: 'C:\\nope', 'ProgramFiles(x86)': 'C:\\nope' },
      () => ({ status: 1, stdout: '', stderr: '', error: null }));
    const r = findHarness(core);
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_HARNESS_NOT_FOUND');
  });
});

describe('FIX-12 launch error 路径 timer 清理（子进程自然退出）', () => {
  it('wait 模式 ENOENT 后进程在 2s 内自然退出（timer 已清除）', () => {
    const ref = path.join(__dirname, '..');
    const script = `
      const path = require('path');
      const { EventEmitter } = require('events');
      const { PassThrough } = require('stream');
      const { createCore } = require(${JSON.stringify(path.join(ref, 'app/create-core.js'))});
      const { createProcPort } = require(${JSON.stringify(path.join(ref, 'ports/proc.js'))});
      const { launchProcess } = require(${JSON.stringify(path.join(ref, 'infra/launch.js'))});
      let childRef = null;
      function fakeChild() {
        const c = new EventEmitter(); c.pid = 1; c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.unref = () => {}; childRef = c; return c;
      }
      const core = createCore({ baseDir: ${JSON.stringify(ref)}, home: require('os').tmpdir(), procPort: createProcPort({ spawn: fakeChild, spawnSync: () => ({ status: 1 }) }) });
      const t0 = Date.now();
      launchProcess(core, { harness: 'x', profile: '.', wait: true, timeoutMs: 60000 }).then((r) => {
        process.stdout.write('RESOLVED ' + (Date.now() - t0) + 'ms ' + (r.error && r.error.code) + '\\n');
      });
      setTimeout(() => { if (childRef) childRef.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' })); }, 10);
      process.on('beforeExit', () => { process.stdout.write('NATURAL_EXIT ' + (Date.now() - t0) + 'ms\\n'); });
      // 安全网 timer 必须 unref：否则即使修复生效（60s timer 已清）也会被本 timer 钉住，beforeExit 不触发
      setTimeout(() => { process.stdout.write('STILL_ALIVE\\n'); process.exit(2); }, 2000).unref();
    `;
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 15000 });
    expect(r.stdout).toContain('RESOLVED');
    expect(r.stdout).toContain('NATURAL_EXIT');
    expect(r.stdout).not.toContain('STILL_ALIVE');
  });
});

describe('FIX-13 monitor.flush 残缺多字节 → UTF8_CORRUPTION 信号', () => {
  it('push [0xE4,0xB8] 后 flush 无 U+FFFD 且标记 __corrupt', () => {
    const dec = createLineDecoder();
    const lines = dec.push(Buffer.from([0xE4, 0xB8]));
    expect(lines).toEqual([]);
    const flushed = dec.flush();
    expect(flushed.length).toBe(1);
    const item = flushed[0];
    expect(typeof item === 'string' && item.includes('\uFFFD')).toBe(false); // 绝不产生 U+FFFD 内容
    expect(item && item.__corrupt).toBe(true); // 标记 UTF8_CORRUPTION 信号
  });

  it('完整 UTF-8 半行 flush 正常返回字符串', () => {
    const dec = createLineDecoder();
    dec.push(Buffer.from('中文', 'utf8'));
    const flushed = dec.flush();
    expect(flushed).toEqual(['中文']);
  });

  it('pipeChildToLog 端时残缺 → run.jsonl 记录 error 行而非 U+FFFD', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix13-'));
    const logFile = path.join(dir, 'run.jsonl');
    const runLog = createRunLog(fsPort, logFile, { now: () => 1000 });
    const { EventEmitter } = require('events');
    const { PassThrough } = require('stream');
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    pipeChildToLog(child, runLog);
    child.stdout.write(Buffer.from([0xE4, 0xB8])); // 残缺
    child.stdout.end();
    // 'end' 事件异步派发：等待事件循环消化后再读取
    await new Promise((resolve) => setTimeout(resolve, 50));
    const text = fs.readFileSync(logFile, 'utf8');
    expect(text).toContain('UTF-8 损坏');
    expect(text.includes('\uFFFD')).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('FIX-14 github ref 校验', () => {
  it('恶意 ref（../）→ ERR_ASSEMBLY_FIELD', () => {
    const r = parseHotpack({
      hotpack: '1.0', id: 'x', name: 'x', version: '1.0.0',
      plugins: [{ id: 'a', name: 'pkg-a', source: { type: 'github', repo: 'org/repo', ref: '../../evil' }, config: {} }]
    });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_ASSEMBLY_FIELD');
  });

  it('合法 ref（main/v2.0.0/feature-tag）通过', () => {
    for (const ref of ['main', 'v2.0.0', 'feature-tag']) {
      const r = parseHotpack({
        hotpack: '1.0', id: 'x', name: 'x', version: '1.0.0',
        plugins: [{ id: 'a', name: 'pkg-a', source: { type: 'github', repo: 'org/repo', ref }, config: {} }]
      });
      expect(r.ok, `ref=${ref}`).toBe(true);
    }
  });
});
