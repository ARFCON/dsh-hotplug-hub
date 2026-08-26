'use strict';
// test/install-npm-channel.test.js — 审计锚点：installNpmPlugin 的 sandbox 直装通道
//
// 背景（审计 A/B，根治）：
//   旧实现先走「dsh plugin add 通道」——但 dsh plugin add 面向【命名 profile】
//   （~/.dsh/profiles/<name>），而 launcher 的 install 落地目标是【sandbox 目录】。
//   旧代码把 sbDir 全文路径当 --profile 名传入，dsh CLI 的 resolveProfileDir 遇路径
//   分隔符即抛错（主通道恒崩溃后静默降级，死代码）；且该通道成功返回后不校验
//   node_modules/<name> 落地，可产生「INSTALL OK 但插件未落地」的假成功。
//   修复后：installNpmPlugin 收敛为 npm install 以 cwd=<sandbox> 直装 + 落地校验，
//   不再触碰 dshPort.pluginAdd。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../app/create-core');
const { createProcPort } = require('../ports/proc');
const { installNpmPlugin } = require('../infra/install');
const { tempDir, isolatedEnv } = require('./helpers');

const ROOT = path.join(__dirname, '..');

function makeCore(overrides = {}) {
  return createCore({
    baseDir: ROOT,
    home: os.tmpdir(),
    platform: overrides.platform || 'win32',
    env: isolatedEnv(os.tmpdir()),
    procPort: overrides.procPort,
    dshPort: overrides.dshPort
  });
}

/** 记录 npm 调用的 proc 端口；onCall 可模拟 npm install 落地（默认落地）。 */
function recordingNpmProc(land = true, status = 0) {
  const calls = [];
  const port = createProcPort({
    spawn: () => { throw new Error('unexpected spawn'); },
    spawnSync: (bin, args, sp) => {
      calls.push({ bin, args });
      if (land && sp && sp.cwd) {
        const spec = args[args.length - 1];
        const name = String(spec).split('@')[0];
        fs.mkdirSync(path.join(sp.cwd, 'node_modules', name), { recursive: true });
        fs.writeFileSync(path.join(sp.cwd, 'node_modules', name, 'package.json'), '{}');
      }
      return { status, error: null, stderr: '', stdout: '' };
    }
  });
  return { port, calls };
}

describe('installNpmPlugin：sandbox 直装（无 dsh 通道）+ 落地校验', () => {
  it('npm 直装成功且落地 → channel=npm，且不触碰 dshPort.pluginAdd', async () => {
    const rec = recordingNpmProc(true);
    let dshCalled = 0;
    const core = makeCore({
      dshPort: {
        pluginAdd: async () => { dshCalled += 1; return { ok: true }; },
        isInstalled: () => false
      },
      procPort: rec.port
    });
    const profile = tempDir('inc-landed-');
    const r = await installNpmPlugin(core, { name: 'pkg-a', version: '1.0.0', resolvedVersion: '1.0.0' }, profile);
    expect(r.ok).toBe(true);
    expect(r.channel).toBe('npm');
    expect(fs.existsSync(path.join(profile, 'node_modules', 'pkg-a'))).toBe(true);
    expect(dshCalled).toBe(0); // 根因修复：dsh 通道已移除，绝不触碰
    fs.rmSync(profile, { recursive: true, force: true });
  });

  it('npm 返回 0 但未落地 → ERR_INSTALL_DEP（不假成功）', async () => {
    const rec = recordingNpmProc(false); // npm 退出 0 但未创建 node_modules/<name>
    const core = makeCore({ procPort: rec.port });
    const profile = tempDir('inc-noland-');
    const r = await installNpmPlugin(core, { name: 'pkg-a', version: '1.0.0', resolvedVersion: '1.0.0' }, profile);
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_INSTALL_DEP');
    fs.rmSync(profile, { recursive: true, force: true });
  });

  it('npm 非零退出 → ERR_INSTALL_FAILED + childExitCode 透传', async () => {
    const rec = recordingNpmProc(false, 7);
    const core = makeCore({ procPort: rec.port });
    const profile = tempDir('inc-fail-');
    const r = await installNpmPlugin(core, { name: 'pkg-a', version: '1.0.0', resolvedVersion: '1.0.0' }, profile);
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_INSTALL_FAILED');
    expect(r.error.childExitCode).toBe(7);
    fs.rmSync(profile, { recursive: true, force: true });
  });
});
