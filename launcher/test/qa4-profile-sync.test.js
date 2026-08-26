'use strict';
// test/qa4-profile-sync.test.js — QA4：syncProfile 失败路径与隔离排除的
// 缺失/损坏容错（先校验后副作用 / 失败回滚 / tmp 清理 / 陈旧链接重建）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../app/create-core');
const { syncProfile, refreshNodeModulesLink, applyExcludes } = require('../infra/profile');
const { createFsPort } = require('../ports/fs');
const { tempDir, isolatedEnv } = require('./helpers');

const ROOT = path.join(__dirname, '..');

function makeCore(home, overrides = {}) {
  return createCore({
    baseDir: ROOT,
    home,
    platform: 'win32',
    env: isolatedEnv(home),
    fsPort: overrides.fsPort,
    dshPort: overrides.dshPort,
    // 独立 roots：每个测试用例隔离根目录（防止 sandboxRoot 复用导致串扰）
    roots: {
      assemblyDir: path.join(home, 'assembly'),
      sandboxRoot: path.join(home, 'sandbox'),
      profilesRoot: path.join(home, '.dsh', 'profiles'),
      storeRoot: path.join(home, '.dsh', 'hotplug-store')
    }
  });
}

function writeSandbox(core, id, opts = {}) {
  const sb = path.join(core.config.roots.sandboxRoot, id);
  fs.mkdirSync(path.join(sb, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(sb, 'package.json'), JSON.stringify({
    name: 'x', version: '0.1.0', private: true,
    dependencies: opts.deps || {},
    dsh: { profile: { bundles: opts.bundles || [] } }
  }));
  if (opts.patch !== false) {
    const YAML = require('yaml');
    fs.writeFileSync(path.join(sb, 'cordis.patch.yml'), YAML.stringify(opts.patch || []));
  }
  if (opts.nodeModules) fs.mkdirSync(path.join(sb, 'node_modules'), { recursive: true });
  return sb;
}

describe('QA4 syncProfile（失败路径与副作用纪律）', () => {
  it('sandbox 缺 package.json → ERR_INSTALL_DEP，profile 目录未被创建（先校验后副作用）', () => {
    const home = tempDir('qa4s1-');
    const core = makeCore(home);
    const r = syncProfile(core, 'demo', { requireHarness: false });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_INSTALL_DEP');
    expect(fs.existsSync(path.join(home, '.dsh', 'profiles', 'demo'))).toBe(false);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('requireHarness:true 且 harness 探测失败 → 同步零副作用', () => {
    const home = tempDir('qa4s2-');
    const core = makeCore(home, {
      dshPort: { findHarness: () => ({ ok: false, error: new Error('not found') }) }
    });
    writeSandbox(core, 'demo');
    const r = syncProfile(core, 'demo', { requireHarness: true });
    expect(r.ok).toBe(false);
    expect(r.error.message).toContain('not found');
    expect(fs.existsSync(path.join(home, '.dsh', 'profiles', 'demo'))).toBe(false);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('patch 合并失败 → 失败回滚 + 无 tmp 残留 + ERR_INSTALL_FAILED（FIX-23/P0-1）', () => {
    const home = tempDir('qa4s3-');
    const realFs = createFsPort(fs);
    // package.json 合并成功、cordis.patch.yml 合并失败（renameSync 第 2 次调用抛错）
    let renameCount = 0;
    const failingFs = {
      ...realFs,
      renameSync: (...a) => {
        renameCount += 1;
        if (renameCount === 2) { const e = new Error('EACCES: rename'); e.code = 'EACCES'; throw e; }
        return fs.renameSync(...a);
      }
    };
    const core = createCore({
      baseDir: ROOT, home, platform: 'win32', env: isolatedEnv(home), fsPort: failingFs,
      roots: {
        assemblyDir: path.join(home, 'assembly'),
        sandboxRoot: path.join(home, 'sandbox'),
        profilesRoot: path.join(home, '.dsh', 'profiles'),
        storeRoot: path.join(home, '.dsh', 'hotplug-store')
      }
    });
    // 预置旧 profile（有快照可回滚）
    const profileDir = path.join(home, '.dsh', 'profiles', 'demo');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'package.json'), '{"old":true}');
    writeSandbox(core, 'demo');
    const r = syncProfile(core, 'demo', { requireHarness: false });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_INSTALL_FAILED');
    // 回滚：旧内容恢复
    expect(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8')).toBe('{"old":true}');
    // 无 tmp 残留
    const leftovers = fs.readdirSync(profileDir).filter((f) => f.includes('.tmp'));
    expect(leftovers).toHaveLength(0);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('P0-1：syncProfile 分节合并——保留 hub 块与 hub 依赖，不整文件覆盖', () => {
    const home = tempDir('qa4s5-');
    const core = makeCore(home);
    const profileDir = path.join(home, '.dsh', 'profiles', 'demo');
    fs.mkdirSync(profileDir, { recursive: true });
    // hub 写入的 package.json（link 依赖 + bundles）；hub 插件真实已安装（node_modules 落地）
    fs.mkdirSync(path.join(profileDir, 'node_modules', 'hub-plugin'), { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
      name: 'web', version: '1.0.0', private: true,
      dependencies: { 'hub-plugin': 'link:./node_modules/hub-plugin' },
      dsh: { profile: { bundles: ['hub-plugin'] } }
    }));
    // hub 写入的 cordis.patch.yml（## hotplug:pack.x 块）
    const YAML = require('yaml');
    fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'),
      '## hotplug:pack.x\n' + YAML.stringify([{ insert: [{ id: 'hp-x-1', name: 'hub-plugin', config: {} }] }]) + '\n');
    // launcher sandbox 产物（deps + patch）
    writeSandbox(core, 'demo', {
      deps: { 'launcher-plugin': '^1.0.0' },
      bundles: ['launcher-plugin'],
      patch: [{ insert: [{ id: 'hp-demo-launcher-plugin', name: 'launcher-plugin', config: {} }] }]
    });
    const r = syncProfile(core, 'demo', { requireHarness: false });
    expect(r.ok).toBe(true);
    const pkg = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
    expect(pkg.dependencies['hub-plugin']).toBe('link:./node_modules/hub-plugin'); // hub 依赖保留
    expect(pkg.dependencies['launcher-plugin']).toBe('^1.0.0'); // launcher 依赖加入
    expect(pkg.dsh.profile.bundles).toContain('hub-plugin'); // hub bundles 保留（已安装，非孤儿）
    expect(pkg.dsh.profile.bundles).toContain('launcher-plugin'); // launcher bundles 加入
    const patch = fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8');
    expect(patch).toContain('## hotplug:pack.x'); // hub 块保留
    expect(patch).toContain('hub-plugin');
    expect(patch).toContain('## launcher:demo'); // launcher 块加入
    expect(patch).toContain('launcher-plugin');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('P0-1 迁移：旧 launcher 覆盖 profile（无标记）→ 陈旧【依赖保留】、陈旧【孤儿 bundle 清理】', () => {
    const home = tempDir('qa4s6-');
    const core = makeCore(home);
    const profileDir = path.join(home, '.dsh', 'profiles', 'demo');
    fs.mkdirSync(profileDir, { recursive: true });
    // 旧 launcher 整文件覆盖产物：name 带 dsh-launcher- 前缀、无 dsh.launcher 标记。
    // P0 根因：依赖无法证明归 launcher 所有（hub/C# 也可能无标记写入同名文件），故【保留】；
    // 但 bundle 是加载敏感的——old-plugin 已从 pack 移除、node_modules 已无它，属【孤儿】，
    // 若保留会令 DSH 启动加载旧 bundle 崩溃，故迁移期必须清理（否则隔离因无标记无法剔除）。
    fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-launcher-demo', version: '0.1.0', private: true,
      dependencies: { 'old-plugin': '^1.0.0' },
      dsh: { profile: { bundles: ['old-plugin'] } }
    }));
    writeSandbox(core, 'demo', {
      deps: { 'new-plugin': '^2.0.0' },
      bundles: ['new-plugin']
    });
    const r = syncProfile(core, 'demo', { requireHarness: false });
    expect(r.ok).toBe(true);
    const pkg = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
    expect(pkg.dependencies['old-plugin']).toBe('^1.0.0'); // 陈旧依赖保留（无害，无法证明所有权）
    expect(pkg.dependencies['new-plugin']).toBe('^2.0.0'); // 新依赖加入
    expect(pkg.dsh.profile.bundles).toEqual(['new-plugin']); // 孤儿旧 bundle 清理，仅保留新 bundle
    expect(pkg.dsh.launcher).toEqual({ dependencies: ['new-plugin'], bundles: ['new-plugin'] });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('P0：旧 launcher 覆盖 profile + hub 后写入的依赖并存 → 迁移删孤儿 bundle、绝不删 hub 已装 bundle', () => {
    const home = tempDir('qa4s7-');
    const core = makeCore(home);
    const profileDir = path.join(home, '.dsh', 'profiles', 'demo');
    fs.mkdirSync(profileDir, { recursive: true });
    // hub 插件真实已安装（node_modules/hub-plugin 落地），old-plugin 已被移除（孤儿）
    fs.mkdirSync(path.join(profileDir, 'node_modules', 'hub-plugin'), { recursive: true });
    // 旧 launcher 整文件覆盖写了 name=dsh-launcher-demo + launcher 的 old-plugin，
    // 随后 hub 的 linkEntryIntoProfile 无标记追加了 hub-plugin（不改 name）。
    fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-launcher-demo', version: '0.1.0', private: true,
      dependencies: { 'old-plugin': '^1.0.0', 'hub-plugin': 'link:./node_modules/hub-plugin' },
      dsh: { profile: { bundles: ['old-plugin', 'hub-plugin'] } }
    }));
    writeSandbox(core, 'demo', {
      deps: { 'new-plugin': '^2.0.0' },
      bundles: ['new-plugin']
    });
    const r = syncProfile(core, 'demo', { requireHarness: false });
    expect(r.ok).toBe(true);
    const pkg = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
    expect(pkg.dependencies['hub-plugin']).toBe('link:./node_modules/hub-plugin'); // hub 依赖绝不能删
    expect(pkg.dependencies['old-plugin']).toBe('^1.0.0'); // 陈旧 launcher 依赖保留（无损优先）
    expect(pkg.dependencies['new-plugin']).toBe('^2.0.0');
    // 孤儿 old-plugin bundle 清理（加载敏感），已安装的 hub bundle 保留，新 bundle 加入
    expect(pkg.dsh.profile.bundles).toEqual(['hub-plugin', 'new-plugin']);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('refreshNodeModulesLink：真实目录移动到备份后重建链接（P1-2 不破坏性删除）', () => {
    const home = tempDir('qa4s4-');
    const core = makeCore(home);
    const profileNm = path.join(home, 'profiles', 'demo', 'node_modules');
    const sandboxNm = path.join(home, 'sandbox', 'node_modules');
    fs.mkdirSync(profileNm, { recursive: true });
    fs.writeFileSync(path.join(profileNm, 'stale.txt'), 'old');
    fs.mkdirSync(sandboxNm, { recursive: true });
    fs.writeFileSync(path.join(sandboxNm, 'fresh.txt'), 'new');
    const note = refreshNodeModulesLink(core.ports.fs, sandboxNm, profileNm);
    expect(note).toContain('已移动到备份');
    // 链接指向 sandbox：读 fresh.txt 而非残留 stale.txt
    expect(fs.readFileSync(path.join(profileNm, 'fresh.txt'), 'utf8')).toBe('new');
    expect(fs.existsSync(path.join(profileNm, 'stale.txt'))).toBe(false);
    // 真实目录未被删除，而是保留在备份目录（可恢复）
    const backup = fs.readdirSync(path.dirname(profileNm)).filter((f) => f.startsWith('node_modules.bak-'));
    expect(backup.length).toBe(1);
    expect(fs.readFileSync(path.join(path.dirname(profileNm), backup[0], 'stale.txt'), 'utf8')).toBe('old');
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('QA4 applyExcludes（隔离排除容错）', () => {
  it('patch.yml 缺失 → 静默成功（launcher 自有 package.json 排除仍生效）', () => {
    const home = tempDir('qa4a1-');
    const core = makeCore(home);
    const profileDir = path.join(home, '.dsh', 'profiles', 'demo');
    fs.mkdirSync(profileDir, { recursive: true });
    // 带 dsh.launcher 标记：pkg-a / pkg-b 均为 launcher 自有（生产路径由 mergeProfileManifest 先写入标记）
    fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
      dependencies: { 'pkg-a': '^1.0.0', 'pkg-b': '^2.0.0' },
      dsh: { profile: { bundles: ['pkg-b'] }, launcher: { dependencies: ['pkg-a', 'pkg-b'], bundles: ['pkg-b'] } }
    }));
    const note = applyExcludes(core, profileDir, ['pkg-b']);
    expect(note).toBeNull();
    const pkg = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
    expect(Object.keys(pkg.dependencies)).toEqual(['pkg-a']);
    expect(pkg.dsh.profile.bundles).toEqual([]);
    expect(pkg.dsh.launcher.dependencies).toEqual(['pkg-a']);
    expect(pkg.dsh.launcher.bundles).toEqual([]);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('P0：其它写者（不同名）依赖/bundle 不被隔离排除误删（所有权按标记限定）', () => {
    const home = tempDir('qa4a0-');
    const core = makeCore(home);
    const profileDir = path.join(home, '.dsh', 'profiles', 'demo');
    fs.mkdirSync(profileDir, { recursive: true });
    // hub 拥有 hub-pkg（无 launcher 标记），launcher 只拥有 pkg-b。隔离 pkg-b 不得误删 hub-pkg。
    // 注：同名条目共享同一 dependencies[name]/bundle 槽位，属结构性不可分（需跨写者命名空间契约），
    // 此测试锁定「不同名条目」的所有权限定语义。
    fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
      dependencies: { 'hub-pkg': 'link:./node_modules/hub-pkg', 'pkg-b': '^2.0.0' },
      dsh: { profile: { bundles: ['hub-pkg', 'pkg-b'] }, launcher: { dependencies: ['pkg-b'], bundles: ['pkg-b'] } }
    }));
    const note = applyExcludes(core, profileDir, ['pkg-b']);
    expect(note).toBeNull();
    const pkg = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
    expect(pkg.dependencies['hub-pkg']).toBe('link:./node_modules/hub-pkg'); // hub 依赖保留
    expect(pkg.dependencies['pkg-b']).toBeUndefined(); // launcher 自有被剔除
    expect(pkg.dsh.profile.bundles).toEqual(['hub-pkg']); // hub bundle 保留
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('package.json 损坏 → note 返回且不崩溃（显式可观测）', () => {
    const home = tempDir('qa4a2-');
    const core = makeCore(home);
    const profileDir = path.join(home, '.dsh', 'profiles', 'demo');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'package.json'), '{broken', 'utf8');
    const note = applyExcludes(core, profileDir, ['pkg-b']);
    expect(note).not.toBeNull();
    expect(note).toContain('package.json');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('launcher 块损坏 → note 返回且 package.json 排除不受影响（P0-1 分节感知）', () => {
    const home = tempDir('qa4a3-');
    const core = makeCore(home);
    const profileDir = path.join(home, '.dsh', 'profiles', 'demo');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
      dependencies: { 'pkg-b': '^2.0.0' },
      dsh: { launcher: { dependencies: ['pkg-b'], bundles: ['pkg-b'] } }
    }));
    fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '## launcher:demo\n[[[broken\n## hotplug:other\n- insert: []\n', 'utf8');
    const note = applyExcludes(core, profileDir, ['pkg-b'], 'demo');
    expect(note).not.toBeNull();
    expect(note).toContain('cordis.patch.yml');
    const pkg = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
    expect(Object.keys(pkg.dependencies)).toHaveLength(0);
    expect(fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8')).toContain('## hotplug:other');
    fs.rmSync(home, { recursive: true, force: true });
  });
});
