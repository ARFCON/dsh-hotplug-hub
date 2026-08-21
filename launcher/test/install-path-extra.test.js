'use strict';
// test/install-path-extra.test.js — infra/install.js 剩余分支全覆盖
// 覆盖：installPathPlugin（真实链接成功/链接失败复制壳回退/无 symlinkSync 降级/
// 陈旧占位清理/目录准备失败语义码）、installGithubPluginWithMirror（win32 cmd 特殊
// 字符拒绝/目标准备失败续试/spawnSync 抛错续试）、installPlugins（混合通道成功、
// 任一失败即中断）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../app/create-core');
const { createProcPort } = require('../ports/proc');
const { createFsPort } = require('../ports/fs');
const { installPathPlugin, installGithubPluginWithMirror, installPlugins } = require('../infra/install');
const { tempDir, isolatedEnv } = require('./helpers');

function makeCore(overrides = {}) {
  return createCore({
    baseDir: path.join(__dirname, '..'),
    home: os.tmpdir(),
    platform: overrides.platform || 'win32',
    env: isolatedEnv(os.tmpdir()),
    procPort: overrides.procPort,
    fsPort: overrides.fsPort
  });
}

const realFsPort = createFsPort(fs);

describe('installPathPlugin（真实链接 + 复制壳回退，C6）', () => {
  it('junction 链接成功 → ok', () => {
    const root = tempDir('ipp-link-');
    const target = path.join(root, 'src');
    const profile = path.join(root, 'profile');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'package.json'), '{}');
    const core = makeCore({ fsPort: realFsPort });
    const r = installPathPlugin(core, { name: 'p', installPath: target }, profile);
    expect(r.ok).toBe(true);
    expect(r.note).toBeUndefined();
    // 真实链接：目标内容可经 node_modules/p 读到
    expect(fs.existsSync(path.join(profile, 'node_modules', 'p', 'package.json'))).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('目标不存在 → ERR_INSTALL_DEP', () => {
    const core = makeCore({ fsPort: realFsPort });
    const r = installPathPlugin(core, { name: 'p', installPath: path.join(os.tmpdir(), 'definitely-not-here-ipp') }, tempDir('ipp-miss-'));
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_INSTALL_DEP');
  });

  it('symlinkSync 抛错 → 复制壳回退并返回 note（显式可观测）', () => {
    const root = tempDir('ipp-fallback-');
    const target = path.join(root, 'src');
    const profile = path.join(root, 'profile');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'package.json'), '{"name":"p"}');
    const badFs = createFsPort({ ...fs, symlinkSync: () => { throw new Error('EPERM'); } });
    const core = makeCore({ fsPort: badFs });
    const r = installPathPlugin(core, { name: 'p', installPath: target }, profile);
    expect(r.ok).toBe(true);
    expect(r.note).toContain('复制壳');
    expect(fs.readFileSync(path.join(profile, 'node_modules', 'p', 'package.json'), 'utf8')).toContain('p');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('无 symlinkSync 方法（旧 fs 端口）→ 复制壳回退', () => {
    const root = tempDir('ipp-nosym-');
    const target = path.join(root, 'src');
    const profile = path.join(root, 'profile');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'package.json'), '{}');
    // createFsPort 总会补上会抛错的 symlinkSync，此分支须用原始对象端口（无该方法）
    const { symlinkSync: _drop, ...noSym } = fs;
    const core = makeCore({ fsPort: noSym });
    const r = installPathPlugin(core, { name: 'p', installPath: target }, profile);
    expect(r.ok).toBe(true);
    expect(r.note).toContain('不支持链接');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('陈旧链接占位先清理再重建（rmdir 失败回退 unlink）', () => {
    const root = tempDir('ipp-stale-');
    const target = path.join(root, 'src');
    const profile = path.join(root, 'profile');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'package.json'), '{}');
    fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true });
    fs.symlinkSync(target, path.join(profile, 'node_modules', 'p'), 'junction');
    // 造一个 rmdirSync 对链接失败、unlinkSync 成功的 fs 端口
    const badFs = createFsPort({
      ...fs,
      symlinkSync: () => { throw new Error('EEXIST'); }, // 链接已存在 → 走到复制壳
      rmdirSync: (p) => { if (fs.lstatSync(p).isSymbolicLink()) throw new Error('EPERM'); return fs.rmdirSync(p); },
      unlinkSync: fs.unlinkSync.bind(fs)
    });
    const core = makeCore({ fsPort: badFs });
    const r = installPathPlugin(core, { name: 'p', installPath: target }, profile);
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(profile, 'node_modules', 'p', 'package.json'))).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('目录准备失败 → ERR_INSTALL_FAILED（不裸抛）', () => {
    const root = tempDir('ipp-fail-');
    const target = path.join(root, 'src');
    const profile = path.join(root, 'profile');
    fs.mkdirSync(target, { recursive: true });
    const badFs = createFsPort({
      ...fs,
      mkdirSync: () => { throw new Error('EACCES'); }
    });
    const core = makeCore({ fsPort: badFs });
    const r = installPathPlugin(core, { name: 'p', installPath: target }, profile);
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_INSTALL_FAILED');
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('installGithubPluginWithMirror 剩余分支', () => {
  const gh = (repo, ref) => ({ name: 'pkg-g', source: { type: 'github', repo }, ref: ref || 'main' });

  it('win32 下 repo/ref/target 含 cmd 特殊字符 → ERR_INSTALL_ACQUIRE（不静默注入）', async () => {
    const core = makeCore({ procPort: createProcPort({ spawn: () => { throw new Error('x'); }, spawnSync: () => ({ status: 0 }) }) });
    const r = await installGithubPluginWithMirror(core, gh('org/repo&calc'), 'C:/profile', null);
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_INSTALL_ACQUIRE');
  });

  it('spawnSync 抛错 → 记 lastErr 续试全部 URL，最终 ERR_INSTALL_ACQUIRE', async () => {
    let calls = 0;
    const core = makeCore({
      procPort: createProcPort({
        spawn: () => { throw new Error('x'); },
        spawnSync: () => { calls += 1; throw new Error('ENOENT: git'); }
      })
    });
    const profile = tempDir('igg-throw-');
    const r = await installGithubPluginWithMirror(core, gh('org/repo'), profile, null);
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_INSTALL_ACQUIRE');
    expect(calls).toBe(4); // 直连 + 3 镜像
    fs.rmSync(profile, { recursive: true, force: true });
  });

  it('目标目录准备失败（mkdir 抛错）→ 记 lastErr 续试下一 URL', async () => {
    let mkdirThrows = true;
    const calls = [];
    const core = makeCore({
      fsPort: createFsPort({
        ...fs,
        mkdirSync: (p, o) => {
          if (mkdirThrows) { mkdirThrows = false; throw new Error('EACCES'); }
          return fs.mkdirSync(p, o);
        },
        rmSync: fs.rmSync.bind(fs),
        existsSync: fs.existsSync.bind(fs)
      }),
      procPort: createProcPort({
        spawn: () => { throw new Error('x'); },
        spawnSync: (bin, args) => {
          calls.push(args);
          const target = args[8];
          if (path.isAbsolute(target) && target.startsWith(os.tmpdir())) {
            fs.mkdirSync(target, { recursive: true });
            fs.writeFileSync(path.join(target, 'package.json'), '{}');
          }
          return { status: 0, error: null, stderr: '', stdout: '' };
        }
      })
    });
    const profile = tempDir('igg-mkdir-');
    const r = await installGithubPluginWithMirror(core, gh('org/repo'), profile, null);
    expect(r.ok).toBe(true); // 第一次 mkdir 失败续试，第二次（镜像1）成功
    expect(calls).toHaveLength(1); // 仅成功的尝试真正 spawn
    fs.rmSync(profile, { recursive: true, force: true });
  });
});

describe('installPlugins 批量安装', () => {
  it('混合通道全部成功 → channels 记录 + nodeModules 标记', async () => {
    const root = tempDir('ip-ok-');
    const target = path.join(root, 'src');
    const profile = path.join(root, 'profile');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'package.json'), '{}');
    const core = makeCore({ fsPort: realFsPort });
    const r = await installPlugins(core, [
      { name: 'p-one', source: { type: 'path' }, installPath: target },
      { name: 'p-two', source: { type: 'path' }, installPath: target }
    ], { profile });
    expect(r.ok).toBe(true);
    expect(r.result.channels.map((c) => c.channel)).toEqual(['path', 'path']);
    expect(r.result.nodeModules).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('任一插件失败 → 立即返回错误（后续不执行）', async () => {
    const root = tempDir('ip-fail-');
    const profile = path.join(root, 'profile');
    const core = makeCore({
      fsPort: realFsPort,
      procPort: createProcPort({
        spawn: () => { throw new Error('x'); },
        spawnSync: () => ({ status: 1, error: null, stderr: 'git: fatal', stdout: '' })
      })
    });
    const r = await installPlugins(core, [
      { name: 'p-gh', source: { type: 'github' }, ref: 'main' }
    ], { profile });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_INSTALL_ACQUIRE');
    fs.rmSync(root, { recursive: true, force: true });
  });
});
