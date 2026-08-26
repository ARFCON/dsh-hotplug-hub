'use strict';
// test/fix-batch4.test.js — FIX-15~18 验收（自愈接线）
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../app/create-core');
const { createProcPort } = require('../ports/proc');
const { createFsPort } = require('../ports/fs');
const { runPipeline } = require('../app/pipeline');
const { installGithubPluginWithMirror } = require('../infra/install');
const { runHeal } = require('../infra/heal');
const { classifySignal } = require('../domain/classify');
const { GITHUB_MIRRORS } = require('../contracts/constants');

const fsPort = createFsPort(fs);

function tempRoots(prefix = 'fix4-') {
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

describe('FIX-15 dsh plugin add 接线', () => {
  it('lazyDshPort.pluginAdd 真实调用 dsh CLI（spawnSync 记录参数）', async () => {
    const calls = [];
    const core = createCore({
      baseDir: __dirname,
      home: os.tmpdir(),
      env: { LOCALAPPDATA: os.tmpdir(), USERPROFILE: os.tmpdir(), HOME: os.tmpdir(), ProgramFiles: os.tmpdir(), 'ProgramFiles(x86)': os.tmpdir(), PATH: os.tmpdir(), DSH_HOME: os.tmpdir() },
      procPort: createProcPort({
        spawn: () => { throw new Error('n/a'); },
        spawnSync: (bin, args) => { calls.push({ bin, args }); return { status: 0, error: null, stderr: '', stdout: '' }; }
      })
    });
    // 隔离 env（A2 修复）：findDshCli 只探测临时路径（不存在内置 bin.js → 走 PATH 分支），
    // 绝不触碰真实 LOCALAPPDATA/~/.dsh。
    const r = await core.ports.dsh.pluginAdd('web', 'pkg-a', '1.2.3');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].args.join(' ')).toContain('plugin');
    expect(calls[0].args.join(' ')).toContain('pkg-a@1.2.3');
    expect(r.ok).toBe(true);
  });

  it('dsh CLI 不存在（spawnSync 失败）→ 返回错误（install 降级 npm）', async () => {
    const core = createCore({
      baseDir: __dirname,
      home: os.tmpdir(),
      env: { LOCALAPPDATA: os.tmpdir(), USERPROFILE: os.tmpdir(), HOME: os.tmpdir(), ProgramFiles: os.tmpdir(), 'ProgramFiles(x86)': os.tmpdir(), PATH: os.tmpdir(), DSH_HOME: os.tmpdir() },
      procPort: createProcPort({
        spawn: () => { throw new Error('n/a'); },
        spawnSync: () => ({ status: 1, error: new Error('ENOENT'), stderr: '', stdout: '' })
      })
    });
    const r = await core.ports.dsh.pluginAdd('web', 'pkg-a', '1.2.3');
    expect(r.ok).toBe(false);
  });
});

describe('FIX-16 自愈五要素', () => {
  it('quarantine 回调未注入 → 显式报错（不静默 ok:true）', async () => {
    const core = createCore({ baseDir: __dirname, home: os.tmpdir(),
      env: { LOCALAPPDATA: os.tmpdir(), USERPROFILE: os.tmpdir(), HOME: os.tmpdir(), ProgramFiles: os.tmpdir(), 'ProgramFiles(x86)': os.tmpdir(), PATH: os.tmpdir(), DSH_HOME: os.tmpdir() }, });
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fix16-'));
    const action = { code: 'CRASH_LOOP', steps: [{ type: 'quarantine' }], budget: 1, rollback: 'x' };
    const r = await runHeal(core, [action], { state: {}, profile, plugins: [] }, { dryRun: false });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_HEAL_BUDGET');
    fs.rmSync(profile, { recursive: true, force: true });
  });

  it('注入 quarantine 回调 → 写入 state.heal.quarantined', async () => {
    const core = createCore({ baseDir: __dirname, home: os.tmpdir(),
      env: { LOCALAPPDATA: os.tmpdir(), USERPROFILE: os.tmpdir(), HOME: os.tmpdir(), ProgramFiles: os.tmpdir(), 'ProgramFiles(x86)': os.tmpdir(), PATH: os.tmpdir(), DSH_HOME: os.tmpdir() }, });
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fix16b-'));
    const state = { launch: { lastExit: 0, retries: 0 }, heal: { history: [], quarantined: [] }, resolved: { plugins: [{ name: 'pkg-bad' }] } };
    const r = await runHeal(core, [{ code: 'CRASH_LOOP', steps: [{ type: 'quarantine' }], budget: 1, rollback: 'x' }],
      {
        state, profile, plugins: [{ name: 'pkg-bad' }],
        quarantine: () => {
          const q = new Set(state.heal.quarantined);
          q.add('pkg-bad');
          state.heal.quarantined = [...q];
          return { ok: true };
        }
      }, { dryRun: false });
    expect(r.ok).toBe(true);
    expect(state.heal.quarantined).toContain('pkg-bad');
    fs.rmSync(profile, { recursive: true, force: true });
  });

  it('CRASH_LOOP 闭环：补救步骤成功后重置崩溃计数（C6 修复：不再恒 ERR_HEAL_BUDGET）', async () => {
    const core = createCore({ baseDir: __dirname, home: os.tmpdir(),
      env: { LOCALAPPDATA: os.tmpdir(), USERPROFILE: os.tmpdir(), HOME: os.tmpdir(), ProgramFiles: os.tmpdir(), 'ProgramFiles(x86)': os.tmpdir(), PATH: os.tmpdir(), DSH_HOME: os.tmpdir() }, });
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fix16c-'));
    // 直接 verifyAction：lastExit=0/null 通过；未重置的非 0 失败（verify 语义不变）
    const { verifyAction } = require('../infra/heal');
    const action = { code: 'CRASH_LOOP', steps: [{ type: 'quarantine' }], budget: 1, rollback: 'x' };
    const vOk = await verifyAction(core, action, { state: { launch: { lastExit: 0, retries: 2 } }, profile, plugins: [] });
    expect(vOk.ok).toBe(true);
    const vBad = await verifyAction(core, action, { state: { launch: { lastExit: 1, retries: 3 } }, profile, plugins: [] });
    expect(vBad.ok).toBe(false);
    // 闭环：补救步骤成功 → lastExit/retries 重置（fresh start）→ runHeal 整体 verified
    const state = { launch: { lastExit: 1, retries: 3 }, heal: { history: [], quarantined: [] } };
    const r = await runHeal(core, [action], { state, profile, plugins: [], quarantine: () => ({ ok: true }) }, { dryRun: false });
    expect(r.ok).toBe(true);
    expect(r.result.history[0].verified).toBe(true);
    expect(state.launch.lastExit).toBeNull(); // 计数已重置
    expect(state.launch.retries).toBe(0);
    fs.rmSync(profile, { recursive: true, force: true });
  });
});

describe('FIX-17 镜像重试链', () => {
  it('直连失败后按 GITHUB_MIRRORS 依次重试（断言调用顺序与 URL 前缀）', async () => {
    const calls = [];
    const core = createCore({
      baseDir: __dirname,
      home: os.tmpdir(),
      env: { LOCALAPPDATA: os.tmpdir(), USERPROFILE: os.tmpdir(), HOME: os.tmpdir(), ProgramFiles: os.tmpdir(), 'ProgramFiles(x86)': os.tmpdir(), PATH: os.tmpdir(), DSH_HOME: os.tmpdir() },
      procPort: createProcPort({
        spawn: () => { throw new Error('n/a'); },
        spawnSync: (bin, args, sp) => {
          calls.push({ bin, args, cwd: sp && sp.cwd });
          // win32 经 cmd /c 包装（C6 对称修复）：['/c','git','clone','--depth','1','--branch',ref,url,relTarget]
          // POSIX 直接 git：['clone','--depth','1','--branch',ref,url,relTarget]
          // m8 修复：relTarget 为相对路径（node_modules/<name>），cwd=<profile>（本地路径含空格不再破坏 cmd 切分）
          const isWin = process.platform === 'win32';
          const urlIdx = isWin ? 7 : 5;
          const relTargetIdx = isWin ? 8 : 6;
          const url = args[urlIdx];
          const relTarget = args[relTargetIdx];
          if (!relTarget || path.isAbsolute(relTarget) || !relTarget.startsWith('node_modules')) {
            throw new Error(`git 相对目标非法（防测试污染）：${relTarget}`);
          }
          const target = path.join(sp.cwd, relTarget);
          if (!target.startsWith(os.tmpdir())) {
            throw new Error(`git target 越界（防测试污染）：${target}`);
          }
          // 第 1 次直连失败，镜像成功（模拟）
          if (url.startsWith('https://github.com/')) return { status: 1, error: null, stderr: 'fatal: unable to access', stdout: '' };
          // 镜像 URL：创建 package.json 模拟 clone 产物
          fs.mkdirSync(target, { recursive: true });
          fs.writeFileSync(path.join(target, 'package.json'), '{}');
          return { status: 0, error: null, stderr: '', stdout: '' };
        }
      })
    });
    const plugin = { name: 'pkg-g', source: { type: 'github', repo: 'org/repo' }, ref: 'main' };
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fix17-'));
    const r = await installGithubPluginWithMirror(core, plugin, profile, null);
    expect(r.ok).toBe(true);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    // 第 2 次调用使用镜像前缀（索引按平台：win32 包装偏移）
    const mirrorUrl = calls[1].args[process.platform === 'win32' ? 7 : 5];
    expect(GITHUB_MIRRORS.some((m) => mirrorUrl.startsWith(m))).toBe(true);
    fs.rmSync(profile, { recursive: true, force: true });
  });
});

describe('FIX-18 classify 零误报保持', () => {
  it('真实 git 行命中 + 用户级 fatal 不误报（C3 修复：fatal 须带引号 URL）', () => {
    expect(classifySignal({ kind: 'stderr', line: "fatal: unable to access 'https://github.com/org/repo.git': timeout" })).not.toBeNull();
    expect(classifySignal({ kind: 'stderr', line: 'fatal: something user-level' })).toBeNull();
    expect(classifySignal({ kind: 'stderr', line: 'fatal: unable to access config' })).toBeNull();
    expect(classifySignal({ kind: 'stderr', line: 'INFO: AUTH service started, 401 connections' })).toBeNull();
  });
});
