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

  it('复制失败 → 失败回滚 + tmp 清理 + ERR_INSTALL_FAILED（FIX-23）', () => {
    const home = tempDir('qa4s3-');
    const realFs = createFsPort(fs);
    // 仅 package.json 复制成功、patch 复制失败（copyFileSync 第二次调用抛错）
    let copyCount = 0;
    const failingFs = {
      ...realFs,
      copyFileSync: (...a) => {
        copyCount += 1;
        if (copyCount === 2) { const e = new Error('EACCES: copy'); e.code = 'EACCES'; throw e; }
        return fs.copyFileSync(...a);
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

  it('refreshNodeModulesLink：陈旧真实目录被重建为链接（杜绝依赖陈旧）', () => {
    const home = tempDir('qa4s4-');
    const core = makeCore(home);
    const profileNm = path.join(home, 'profiles', 'demo', 'node_modules');
    const sandboxNm = path.join(home, 'sandbox', 'node_modules');
    fs.mkdirSync(profileNm, { recursive: true });
    fs.writeFileSync(path.join(profileNm, 'stale.txt'), 'old');
    fs.mkdirSync(sandboxNm, { recursive: true });
    fs.writeFileSync(path.join(sandboxNm, 'fresh.txt'), 'new');
    const note = refreshNodeModulesLink(core.ports.fs, sandboxNm, profileNm);
    expect(note).toBeNull();
    const st = fs.lstatSync(profileNm);
    expect(st.isSymbolicLink() || st.isDirectory()).toBe(true);
    // 链接指向 sandbox：读 fresh.txt 而非残留 stale.txt
    expect(fs.readFileSync(path.join(profileNm, 'fresh.txt'), 'utf8')).toBe('new');
    expect(fs.existsSync(path.join(profileNm, 'stale.txt'))).toBe(false);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('QA4 applyExcludes（隔离排除容错）', () => {
  it('patch.yml 缺失 → 静默成功（package.json 排除仍生效）', () => {
    const home = tempDir('qa4a1-');
    const core = makeCore(home);
    const profileDir = path.join(home, '.dsh', 'profiles', 'demo');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
      dependencies: { 'pkg-a': '^1.0.0', 'pkg-b': '^2.0.0' },
      dsh: { profile: { bundles: ['pkg-b'] } }
    }));
    const note = applyExcludes(core, profileDir, ['pkg-b']);
    expect(note).toBeNull();
    const pkg = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
    expect(Object.keys(pkg.dependencies)).toEqual(['pkg-a']);
    expect(pkg.dsh.profile.bundles).toEqual([]);
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

  it('patch.yml 损坏 → note 返回且 package.json 排除不受影响', () => {
    const home = tempDir('qa4a3-');
    const core = makeCore(home);
    const profileDir = path.join(home, '.dsh', 'profiles', 'demo');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ dependencies: { 'pkg-b': '^2.0.0' } }));
    fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '[[[broken', 'utf8');
    const note = applyExcludes(core, profileDir, ['pkg-b']);
    expect(note).not.toBeNull();
    expect(note).toContain('cordis.patch.yml');
    const pkg = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
    expect(Object.keys(pkg.dependencies)).toHaveLength(0);
    fs.rmSync(home, { recursive: true, force: true });
  });
});
