'use strict';
// test/qa4-install.test.js — QA4：install 通道直接单测
// 覆盖 npm 降级分支（成功/失败/childExitCode 透传/node_modules 校验/win32 cmd 包装）、
// github 镜像链（explicitMirror 语义、缺 package.json 续试）、verifyInstall 缺失清单。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../app/create-core');
const { createProcPort } = require('../ports/proc');
const {
  installNpmPlugin,
  installGithubPluginWithMirror,
  verifyInstall,
  installPlugins
} = require('../infra/install');
const { tempDir, isolatedEnv } = require('./helpers');

const ROOT = path.join(__dirname, '..');

function makeCore(overrides = {}) {
  return createCore({
    baseDir: ROOT,
    home: os.tmpdir(),
    platform: overrides.platform || 'win32',
    env: isolatedEnv(os.tmpdir()),
    procPort: overrides.procPort,
    dshPort: overrides.dshPort,
    fsPort: overrides.fsPort
  });
}

function recordingProc(status, opts = {}) {
  const calls = [];
  const port = createProcPort({
    spawn: () => { throw new Error('unexpected spawn'); },
    spawnSync: (bin, args, sp) => {
      calls.push({ bin, args });
      if (opts.onCall) opts.onCall(bin, args);
      return { status, error: null, stderr: opts.stderr || '', stdout: opts.stdout || '' };
    }
  });
  return { port, calls };
}

function dshOk() {
  return { pluginAdd: async () => ({ ok: true }), isInstalled: () => false };
}

function dshFail() {
  return { pluginAdd: async () => ({ ok: false, error: new Error('dsh CLI 不可用') }), isInstalled: () => false };
}

describe('QA4 installNpmPlugin（dsh 通道 + npm 降级）', () => {
  it('dsh 通道成功 → channel dsh，不降级 npm', async () => {
    const core = makeCore({ dshPort: dshOk(), procPort: recordingProc(0).port });
    const profile = tempDir('qa4i1-');
    const r = await installNpmPlugin(core, { name: 'pkg-a', version: '1.0.0', resolvedVersion: '1.0.0' }, profile);
    expect(r.ok).toBe(true);
    expect(r.channel).toBe('dsh');
    fs.rmSync(profile, { recursive: true, force: true });
  });

  it('dsh 通道失败 → npm 降级；win32 用 cmd.exe /c 包装且带 spec', async () => {
    const rec = recordingProc(0);
    const core = makeCore({ dshPort: dshFail(), procPort: rec.port });
    const profile = tempDir('qa4i2-');
    fs.mkdirSync(path.join(profile, 'node_modules', 'pkg-a'), { recursive: true }); // 落地校验
    const r = await installNpmPlugin(core, { name: 'pkg-a', version: '1.0.0', resolvedVersion: '1.0.0' }, profile);
    expect(r.ok).toBe(true);
    expect(r.channel).toBe('npm');
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].bin).toBe('cmd.exe');
    expect(rec.calls[0].args).toEqual(['/c', 'npm', 'install', '--no-audit', '--no-fund', 'pkg-a@1.0.0']);
    fs.rmSync(profile, { recursive: true, force: true });
  });

  it('POSIX 平台 npm 降级直接 spawn npm（无 cmd 包装）', async () => {
    const rec = recordingProc(0);
    const core = makeCore({ dshPort: dshFail(), procPort: rec.port, platform: 'linux' });
    const profile = tempDir('qa4i3-');
    fs.mkdirSync(path.join(profile, 'node_modules', 'pkg-a'), { recursive: true });
    const r = await installNpmPlugin(core, { name: 'pkg-a' }, profile);
    expect(r.ok).toBe(true);
    expect(rec.calls[0].bin).toBe('npm');
    expect(rec.calls[0].args).toEqual(['install', '--no-audit', '--no-fund', 'pkg-a']);
    fs.rmSync(profile, { recursive: true, force: true });
  });

  it('npm 失败 → ERR_INSTALL_FAILED + childExitCode 透传真实退出码（C6）', async () => {
    const rec = recordingProc(7, { stderr: 'npm ERR! EACCES' });
    const core = makeCore({ dshPort: dshFail(), procPort: rec.port });
    const profile = tempDir('qa4i4-');
    const r = await installNpmPlugin(core, { name: 'pkg-a', version: '1.0.0', resolvedVersion: '1.0.0' }, profile);
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_INSTALL_FAILED');
    expect(r.error.childExitCode).toBe(7);
    expect(r.error.exitCode).toBe(6); // 契约码仍是安装域
    fs.rmSync(profile, { recursive: true, force: true });
  });

  it('npm 成功但 node_modules/<name> 未落地 → ERR_INSTALL_DEP（复制壳识别）', async () => {
    const rec = recordingProc(0);
    const core = makeCore({ dshPort: dshFail(), procPort: rec.port });
    const profile = tempDir('qa4i5-');
    const r = await installNpmPlugin(core, { name: 'pkg-a', version: '1.0.0', resolvedVersion: '1.0.0' }, profile);
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_INSTALL_DEP');
    fs.rmSync(profile, { recursive: true, force: true });
  });

  it('spawnSync 同步抛错（npm 无法执行）→ ERR_INSTALL_FAILED 不崩溃', async () => {
    const core = makeCore({
      dshPort: dshFail(),
      procPort: createProcPort({
        spawn: () => { throw new Error('x'); },
        spawnSync: () => { const e = new Error('ENOENT: npm'); e.code = 'ENOENT'; throw e; }
      })
    });
    const profile = tempDir('qa4i6-');
    const r = await installNpmPlugin(core, { name: 'pkg-a' }, profile);
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_INSTALL_FAILED');
    fs.rmSync(profile, { recursive: true, force: true });
  });
});

describe('QA4 installGithubPluginWithMirror（镜像链语义）', () => {
  function gitProc(status, opts = {}) {
    const calls = [];
    const port = createProcPort({
      spawn: () => { throw new Error('x'); },
      spawnSync: (bin, args) => {
        calls.push({ bin, args });
        if (opts.onCall) opts.onCall(args);
        return { status, error: null, stderr: '', stdout: '' };
      }
    });
    return { port, calls };
  }

  function githubPlugin(repo, ref) {
    return { name: 'pkg-g', source: { type: 'github', repo }, ref: ref || 'main' };
  }

  it('explicitMirror 只试该镜像（heal onMirror 语义：不直连、不串行全部镜像）', async () => {
    // onCall 模拟真实 git clone 产物：创建 target 目录 + package.json
    // win32 包装后 args = ['/c','git','clone','--depth','1','--branch',ref,url,target]
    const rec = gitProc(0, { onCall: (args) => {
      const target = args[8];
      // 防污染防护：target 必须是绝对路径且位于系统临时目录内
      //（索引错位曾把 ref 'main' 当 target 在 vitest cwd 下创建相对路径残留）
      if (!path.isAbsolute(target) || !target.startsWith(os.tmpdir())) {
        throw new Error(`git target 越界（防测试污染）：${target}`);
      }
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'package.json'), '{}');
    } });
    const core = makeCore({ procPort: rec.port });
    const profile = tempDir('qa4g1-');
    const r = await installGithubPluginWithMirror(core, githubPlugin('org/repo'), profile, 'https://ghfast.top/');
    expect(r.ok).toBe(true);
    expect(r.mirror).toBe('https://ghfast.top/https://github.com/org/repo.git');
    expect(rec.calls).toHaveLength(1);
    // win32 经 cmd /c 包装（C6 对称修复：git.cmd 形态可执行）
    expect(rec.calls[0].args[0]).toBe('/c');
    expect(rec.calls[0].args[1]).toBe('git');
    expect(rec.calls[0].args[7]).toBe('https://ghfast.top/https://github.com/org/repo.git');
    fs.rmSync(profile, { recursive: true, force: true });
  });

  it('clone 成功但缺 package.json → 续试下一 URL，全部失败返回 ERR_INSTALL_ACQUIRE', async () => {
    const rec = gitProc(0); // 永远"成功"但从不创建 package.json
    const core = makeCore({ procPort: rec.port });
    const profile = tempDir('qa4g2-');
    const r = await installGithubPluginWithMirror(core, githubPlugin('org/repo'), profile, null);
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_INSTALL_ACQUIRE');
    // 直连 + 3 个镜像 = 4 次尝试
    expect(rec.calls.length).toBe(4);
    expect(rec.calls[0].args[7]).toBe('https://github.com/org/repo.git');
    expect(rec.calls[1].args[7]).toBe('https://ghfast.top/https://github.com/org/repo.git');
    fs.rmSync(profile, { recursive: true, force: true });
  });

  it('POSIX 平台不包装：直接 spawn git（无 /c 前缀）', async () => {
    const rec = gitProc(0, { onCall: (args) => {
      const target = args[6]; // ['clone','--depth','1','--branch',ref,url,target]
      if (!path.isAbsolute(target) || !target.startsWith(os.tmpdir())) {
        throw new Error(`git target 越界（防测试污染）：${target}`);
      }
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'package.json'), '{}');
    } });
    const core = makeCore({ procPort: rec.port, platform: 'linux' });
    const profile = tempDir('qa4g4-');
    const r = await installGithubPluginWithMirror(core, githubPlugin('org/repo'), profile, null);
    expect(r.ok).toBe(true);
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].bin).toBe('git');
    expect(rec.calls[0].args[0]).toBe('clone');
    expect(rec.calls[0].args[5]).toBe('https://github.com/org/repo.git');
    fs.rmSync(profile, { recursive: true, force: true });
  });

  it('win32 特殊字符参数 → 显式拒绝且零 spawn（防 cmd 注入）', async () => {
    const rec = gitProc(0);
    const core = makeCore({ procPort: rec.port });
    const profile = tempDir('qa4g5-');
    const r = await installGithubPluginWithMirror(core, githubPlugin('org/repo&rm'), profile, null);
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_INSTALL_ACQUIRE');
    expect(rec.calls).toHaveLength(0);
    fs.rmSync(profile, { recursive: true, force: true });
  });

  it('git clone 非零退出 → childExitCode 透传（与 npm 通道语义一致）', async () => {
    const rec = gitProc(128);
    const core = makeCore({ procPort: rec.port });
    const profile = tempDir('qa4g3-');
    const r = await installGithubPluginWithMirror(core, githubPlugin('org/repo'), profile, null);
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_INSTALL_ACQUIRE');
    expect(r.error.childExitCode).toBe(128);
    fs.rmSync(profile, { recursive: true, force: true });
  });
});

describe('QA4 verifyInstall / installPlugins（批量语义）', () => {
  it('verifyInstall 返回缺失清单', () => {
    const core = makeCore({});
    const profile = tempDir('qa4v1-');
    fs.mkdirSync(path.join(profile, 'node_modules', 'pkg-a'), { recursive: true });
    const r = verifyInstall(core, [
      { name: 'pkg-a', source: { type: 'npm' } },
      { name: 'pkg-b', source: { type: 'npm' } }
    ], profile);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['pkg-b']);
    fs.rmSync(profile, { recursive: true, force: true });
  });

  it('installPlugins 中途失败即中断返回错误（不留半批成功掩盖）', async () => {
    const core = makeCore({
      dshPort: dshFail(),
      procPort: recordingProc(1, { stderr: 'npm ERR!' }).port
    });
    const profile = tempDir('qa4v2-');
    fs.mkdirSync(path.join(profile, 'node_modules', 'pkg-b'), { recursive: true });
    const r = await installPlugins(core, [
      { name: 'pkg-a', source: { type: 'npm' }, version: '1.0.0' },
      { name: 'pkg-b', source: { type: 'path' }, installPath: tempDir('qa4v2b-') }
    ], { profile });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_INSTALL_FAILED');
    fs.rmSync(profile, { recursive: true, force: true });
  });
});
