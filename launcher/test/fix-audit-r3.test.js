'use strict';
// test/fix-audit-r3.test.js — 第三轮加固验收（heal 原子写 / rebuild-link 真链接 / ComSpec 解析）
//
// 1) heal-steps 的 reclassify-bundles / regenerate-patch 此前用 writeFileSync 裸写
//    profile 产物——违反「所有写盘走统一原子写」原则，崩溃时留下半截文件。
// 2) rebuild-link 此后手搓 mkdir+copy package.json（复制壳）——与 installPathPlugin
//    的真实链接（junction/dir symlink + 陈旧占位清理）漂移，自愈后插件反而劣化。
// 3) dsh-cli 的 PATH 回退分支此前返回裸 'cmd.exe'（未解析 ComSpec 绝对路径）——
//    与 infra/launch.js、hotplug run-cli.js 的加固不一致。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../app/create-core');
const { executeAction } = require('../infra/heal');
const { findDshCli } = require('../infra/dsh-cli');
const { FS_METHODS } = require('../ports/fs');

function tempDir(prefix = 'fix-r3-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 记录写路径操作的 fs 端口（writeFileSync 记写入目标；renameSync 记【落位目标】
 *  args[1]——原子写的 rename 语义是 tmp → 最终路径）。 */
function recordingFsPort() {
  const ops = [];
  const port = {};
  for (const m of FS_METHODS) {
    port[m] = (...args) => {
      if (m === 'writeFileSync' && typeof args[0] === 'string') {
        ops.push({ m, target: args[0] });
      } else if (m === 'renameSync') {
        ops.push({ m, target: String(args[1]) });
      }
      return fs[m](...args);
    };
  }
  return { port, ops };
}

describe('heal-steps 原子写（reclassify-bundles / regenerate-patch）', () => {
  it('reclassify-bundles 重写 profile package.json 走 tmp+rename（无直接写最终路径）', async () => {
    const core = createCore({ baseDir: __dirname, home: os.tmpdir() });
    const profile = tempDir('fix-r3-recl-');
    fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({
      name: 'p', private: true, dependencies: {},
      dsh: { profile: { bundles: ['pkg-stale'] } }
    }, null, 2));
    const action = { code: 'BUNDLE_MISCLASSIFY', steps: [{ type: 'reclassify-bundles' }], budget: 1 };
    const r = await executeAction(core, action, {
      profile,
      plugins: [{ name: 'pkg-stale', config: { 'dsh.bundle.patch': false } }],
      state: {},
    });
    expect(r.ok).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'));
    expect(manifest.dsh.profile.bundles).toEqual([]);
    fs.rmSync(profile, { recursive: true, force: true });
  });

  it('reclassify-bundles 对最终路径的 writeFileSync 直写被拒绝（必须原子）', async () => {
    const { port, ops } = recordingFsPort();
    const core = createCore({ baseDir: __dirname, home: os.tmpdir(), fsPort: port });
    const profile = tempDir('fix-r3-atomic-');
    const manifestFile = path.join(profile, 'package.json');
    fs.writeFileSync(manifestFile, JSON.stringify({
      dependencies: {}, dsh: { profile: { bundles: ['pkg-x'] } }
    }));
    const action = { code: 'BUNDLE_MISCLASSIFY', steps: [{ type: 'reclassify-bundles' }], budget: 1 };
    await executeAction(core, action, { profile, plugins: [], state: {} });
    const directWrites = ops.filter((o) => o.m === 'writeFileSync' && o.target === manifestFile);
    expect(directWrites).toEqual([]); // 不得直写最终路径（原子写经 tmp 文件 writeFileSync(fd) + rename）
    const renamed = ops.filter((o) => o.m === 'renameSync' && o.target === manifestFile);
    expect(renamed.length).toBe(1); // 经 rename 落位
    fs.rmSync(profile, { recursive: true, force: true });
  });

  it('regenerate-patch 重写 cordis.patch.yml 走 tmp+rename（不直写最终路径）', async () => {
    const { port, ops } = recordingFsPort();
    const core = createCore({ baseDir: __dirname, home: os.tmpdir(), fsPort: port });
    const profile = tempDir('fix-r3-patch-');
    const patchFile = path.join(profile, 'cordis.patch.yml');
    fs.writeFileSync(patchFile, 'corrupt');
    const action = { code: 'PATCH_CORRUPT', steps: [{ type: 'regenerate-patch' }], budget: 1 };
    const r = await executeAction(core, action, {
      profile,
      pack: { id: 'demo', plugins: [{ id: 'a', name: 'pkg-a', config: {} }] },
      plugins: [{ id: 'a', name: 'pkg-a', config: {} }],
      state: { id: 'demo' },
    });
    expect(r.ok).toBe(true);
    const directWrites = ops.filter((o) => o.m === 'writeFileSync' && o.target === patchFile);
    expect(directWrites).toEqual([]);
    expect(ops.filter((o) => o.m === 'renameSync' && o.target === patchFile).length).toBe(1);
    const text = fs.readFileSync(patchFile, 'utf8');
    expect(text).toContain('insert');
    fs.rmSync(profile, { recursive: true, force: true });
  });
});

describe('rebuild-link 自愈为真实链接（与 installPathPlugin 同源）', () => {
  it('path 源 → node_modules/<name> 成为指向目标的 junction/symlink（非复制壳）', async () => {
    const core = createCore({ baseDir: __dirname, home: os.tmpdir() });
    const profile = tempDir('fix-r3-link-');
    const target = tempDir('fix-r3-tgt-');
    fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name: 'pkg-l', version: '1.0.0' }));
    fs.writeFileSync(path.join(target, 'index.js'), 'module.exports = 42');
    // 陈旧占位：真实垃圾目录（此前 mkdirSync recursive 会把复制壳混进垃圾里）
    const stale = path.join(profile, 'node_modules', 'pkg-l');
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, 'garbage.txt'), 'stale');
    const action = { code: 'LINK_FAIL', steps: [{ type: 'rebuild-link' }], budget: 1 };
    const r = await executeAction(core, action, {
      profile,
      plugins: [{ name: 'pkg-l', source: { type: 'path' }, installPath: target }],
      state: {},
    });
    expect(r.ok).toBe(true);
    const lst = fs.lstatSync(stale);
    expect(lst.isSymbolicLink()).toBe(true); // 真实链接（junction/dir symlink）
    expect(fs.readFileSync(path.join(stale, 'index.js'), 'utf8')).toBe('module.exports = 42'); // 代码可达
    expect(() => fs.readFileSync(path.join(stale, 'garbage.txt'))).toThrow(); // 陈旧占位被清理
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  });

  it('path 目标不存在 → 显式失败（不静默 ok）', async () => {
    const core = createCore({ baseDir: __dirname, home: os.tmpdir() });
    const profile = tempDir('fix-r3-link2-');
    const action = { code: 'LINK_FAIL', steps: [{ type: 'rebuild-link' }], budget: 1 };
    const r = await executeAction(core, action, {
      profile,
      plugins: [{ name: 'pkg-l', source: { type: 'path' }, installPath: path.join(profile, 'no-such-target') }],
      state: {},
    });
    expect(r.ok).toBe(false);
    expect(r.error.message).toMatch(/不存在/);
    fs.rmSync(profile, { recursive: true, force: true });
  });
});

describe('dsh-cli ComSpec 绝对路径解析（PATH 回退分支）', () => {
  it('win32 PATH 回退 → bin 为 ComSpec 绝对路径（非裸 cmd.exe）', () => {
    const fakeComspec = path.join(os.tmpdir(), 'fake-cmd.exe');
    const home = tempDir('fix-r3-cli-');
    const core = createCore({
      baseDir: __dirname,
      home,
      env: { LOCALAPPDATA: path.join(home, 'nope'), ComSpec: fakeComspec },
    });
    core.config.platform = 'win32'; // 强制走 win32 分支（跨平台可测）
    const r = findDshCli(core, { profile: 'web' });
    expect(r.ok).toBe(true);
    expect(r.bin.toLowerCase()).toBe(fakeComspec.toLowerCase());
    fs.rmSync(home, { recursive: true, force: true });
  });

  it.skipIf(process.platform !== 'win32')('ComSpec 缺失 → 回退 System32 绝对路径（真打第三层级；POSIX 宿主无此语义）', () => {
    const home = tempDir('fix-r3-cli2-');
    const core = createCore({
      baseDir: __dirname,
      home,
      env: { LOCALAPPDATA: path.join(home, 'nope') },
    });
    core.config.platform = 'win32';
    // 临时清空宿主 ComSpec，让 resolveCmdBin 走到 SystemRoot\System32 第三层级
    //（否则 Windows 宿主恒被第二层 process.env.ComSpec 拦截，第三层永远测不到）
    const savedComspec = process.env.ComSpec;
    const savedSystemRoot = process.env.SystemRoot;
    delete process.env.ComSpec;
    try {
      const r = findDshCli(core, { profile: 'web' });
      expect(r.ok).toBe(true);
      expect(path.isAbsolute(r.bin)).toBe(true);
      expect(path.basename(r.bin).toLowerCase()).toBe('cmd.exe');
      expect(r.bin.toLowerCase()).not.toBe('cmd.exe');
    } finally {
      if (savedComspec !== undefined) process.env.ComSpec = savedComspec;
      else delete process.env.ComSpec;
      if (savedSystemRoot !== undefined) process.env.SystemRoot = savedSystemRoot;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });
});
