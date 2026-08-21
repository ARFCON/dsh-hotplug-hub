'use strict';
// test/heal-steps.test.js — infra/heal-steps.js executeAction 全步骤（FIX-16：不静默 ok）
// 未知步骤/回调缺失显式报错；CRASH_LOOP 补救成功后重置崩溃计数闭环（C6）。
const path = require('path');
const fs = require('fs');
const { executeAction } = require('../infra/heal-steps');
const { createFsPort } = require('../ports/fs');
const { createSnapshot } = require('../infra/snapshot');
const { tempDir } = require('./helpers');

const fsPort = createFsPort(fs);

function makeCore(overrides = {}) {
  return {
    ports: { fs: fsPort, registry: null },
    infra: { harness: { findHarness: () => ({ ok: true, harness: '/fake/harness' }) } },
    ...overrides
  };
}

const npmPlugin = (name, version, extra = {}) => ({
  id: `p-${name}`,
  name,
  version,
  source: { type: 'npm' },
  config: {},
  resolvedVersion: null,
  pinned: false,
  installPath: null,
  ref: null,
  ...extra
});
describe('infra/heal-steps.js executeAction 全步骤（FIX-16：不静默 ok）', () => {
  it('无 steps → ok；空 steps 的 CRASH_LOOP 不重置计数', async () => {
    const state = { launch: { lastExit: 5, retries: 2 }, dirty: false };
    const r = await executeAction(makeCore(), { code: 'CRASH_LOOP', steps: [] }, { state });
    expect(r.ok).toBe(true);
    expect(state.launch.lastExit).toBe(5); // 未重置
  });

  describe('reinstall', () => {
    it('空插件列表 → ok（installPlugins 空循环）', async () => {
      const r = await executeAction(makeCore(), { code: 'INSTALL_FAIL', steps: [{ type: 'reinstall' }] }, { plugins: [], profile: tempDir('hs-reinstall-') });
      expect(r.ok).toBe(true);
    });
  });

  describe('rollback-snapshot', () => {
    it('无快照 → ERR_HEAL_ROLLBACK', async () => {
      const r = await executeAction(makeCore(), { code: 'X', steps: [{ type: 'rollback-snapshot' }] }, { state: {}, profile: tempDir('hs-rs-none-') });
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('ERR_HEAL_ROLLBACK');
    });
    it('有快照 → 恢复', async () => {
      const profile = tempDir('hs-rs-');
      fs.writeFileSync(path.join(profile, 'f.txt'), 'orig');
      const snap = createSnapshot(fsPort, profile);
      fs.writeFileSync(path.join(profile, 'f.txt'), 'MUT');
      const r = await executeAction(makeCore(), { code: 'X', steps: [{ type: 'rollback-snapshot' }] }, { state: { rollback: { snapshot: snap.snapshot } }, profile });
      expect(r.ok).toBe(true);
      expect(fs.readFileSync(path.join(profile, 'f.txt'), 'utf8')).toBe('orig');
      fs.rmSync(profile, { recursive: true, force: true });
    });
  });

  describe('disable-recent', () => {
    it('无插件 → ERR_HEAL_BUDGET', async () => {
      const r = await executeAction(makeCore(), { code: 'CRASH_LOOP', steps: [{ type: 'disable-recent' }] }, { plugins: [], state: { launch: {} } });
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('ERR_HEAL_BUDGET');
    });
    it('quarantine 回调 ok → 禁用最后一个插件，崩溃计数重置（C6 闭环）', async () => {
      const q = vi.fn(() => ({ ok: true }));
      const plugins = [npmPlugin('a'), npmPlugin('b')];
      const state = { launch: { lastExit: 3, retries: 1 } };
      const r = await executeAction(makeCore(), { code: 'CRASH_LOOP', steps: [{ type: 'disable-recent' }] }, { plugins, state, quarantine: q });
      expect(r.ok).toBe(true);
      expect(q).toHaveBeenCalledWith('b');
      // C6 闭环：补救成功 → 崩溃计数重置
      expect(state.launch.lastExit).toBeNull();
      expect(state.launch.retries).toBe(0);
      expect(state.dirty).toBe(true);
    });
    it('quarantine 回调失败 → ERR_HEAL_BUDGET；未注入 → ERR_HEAL_BUDGET', async () => {
      const r1 = await executeAction(makeCore(), { code: 'CRASH_LOOP', steps: [{ type: 'disable-recent' }] }, { plugins: [npmPlugin('a')], state: { launch: {} }, quarantine: () => ({ ok: false, error: new Error('x') }) });
      expect(r1.ok).toBe(false);
      expect(r1.error.code).toBe('ERR_HEAL_BUDGET');
      const r2 = await executeAction(makeCore(), { code: 'CRASH_LOOP', steps: [{ type: 'disable-recent' }] }, { plugins: [npmPlugin('a')], state: { launch: {} } });
      expect(r2.ok).toBe(false);
      expect(r2.error.message).toContain('quarantine 回调未注入');
    });
  });

  describe('quarantine', () => {
    it('回调 ok → 透传；回调失败 → 包装 ERR_HEAL_BUDGET；未注入 → 显式报错', async () => {
      const ok = await executeAction(makeCore(), { code: 'X', steps: [{ type: 'quarantine' }] }, { quarantine: () => ({ ok: true }) });
      expect(ok.ok).toBe(true);
      const bad = await executeAction(makeCore(), { code: 'X', steps: [{ type: 'quarantine' }] }, { quarantine: () => ({ ok: false, error: new Error('q') }) });
      expect(bad.ok).toBe(false);
      expect(bad.error.code).toBe('ERR_HEAL_BUDGET');
      const none = await executeAction(makeCore(), { code: 'X', steps: [{ type: 'quarantine' }] }, {});
      expect(none.ok).toBe(false);
      expect(none.error.message).toContain('quarantine 回调未注入');
    });
  });

  describe('pin-compatible', () => {
    const registry = {
      availableVersions: (name) => ({ a: ['1.0.0'], b: ['2.0.0'] }[name] || []),
      resolveBest: (name, range) => ({ a: '1.0.0', b: '2.0.0' }[name] || null)
    };
    it('repin 成功并把 resolvedVersion 写回原插件（引用）', async () => {
      const plugins = [npmPlugin('a', '^1.0.0'), npmPlugin('b', '^2.0.0')];
      const r = await executeAction(makeCore({ ports: { fs: fsPort, registry } }), { code: 'VERSION_CONFLICT', steps: [{ type: 'pin-compatible' }] }, { plugins, state: { id: 'x' } });
      expect(r.ok).toBe(true);
      expect(plugins[0].resolvedVersion).toBe('1.0.0');
      expect(plugins[1].resolvedVersion).toBe('2.0.0');
    });
    it('repin 后仍冲突 → ERR_CONFLICT_BLOCKED', async () => {
      // 两个同名牌不同 range，registry 对两个 range 都有满足版本 → resolve 成功、
      // pin 后版本仍不同 → checkConflicts error
      const registry2 = {
        availableVersions: () => ['1.0.0', '2.0.0'],
        resolveBest: () => '1.0.0'
      };
      const plugins = [
        npmPlugin('dup', '^1.0.0'),
        { ...npmPlugin('dup', '^2.0.0'), id: 'p-dup-2' }
      ];
      const r = await executeAction(makeCore({ ports: { fs: fsPort, registry: registry2 } }), { code: 'VERSION_CONFLICT', steps: [{ type: 'pin-compatible' }] }, { plugins, state: { id: 'x' } });
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('ERR_CONFLICT_BLOCKED');
    });
    it('registry 无满足版本 → resolve 失败透传 ERR_INSTALL_ACQUIRE', async () => {
      const plugins = [npmPlugin('a', '^9.0.0')];
      const r = await executeAction(makeCore({ ports: { fs: fsPort, registry: { availableVersions: () => ['1.0.0'], resolveBest: () => null } } }), { code: 'VERSION_CONFLICT', steps: [{ type: 'pin-compatible' }] }, { plugins, state: { id: 'x' } });
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('ERR_INSTALL_ACQUIRE');
    });
  });

  describe('mirror-retry', () => {
    it('首个镜像失败、第二个成功 → ok（执行顺序验证）', async () => {
      const calls = [];
      const onMirror = async (m) => { calls.push(m); return m === 'm2' ? { ok: true } : { ok: false, error: new Error('fail') }; };
      const r = await executeAction(makeCore(), { code: 'GITHUB_ACQUIRE_FAIL', steps: [{ type: 'mirror-retry', mirrors: ['m1', 'm2'] }] }, { onMirror });
      expect(r.ok).toBe(true);
      expect(calls).toEqual(['m1', 'm2']);
    });
    it('全部失败 → 显式失败携带 lastErr', async () => {
      const onMirror = async () => ({ ok: false, error: new Error('ECONNREFUSED') });
      const r = await executeAction(makeCore(), { code: 'GITHUB_ACQUIRE_FAIL', steps: [{ type: 'mirror-retry', mirrors: ['m1'] }] }, { onMirror });
      expect(r.ok).toBe(false);
      expect(r.error.message).toContain('ECONNREFUSED');
    });
    it('无 onMirror → 显式失败（不静默 ok）', async () => {
      const r = await executeAction(makeCore(), { code: 'GITHUB_ACQUIRE_FAIL', steps: [{ type: 'mirror-retry', mirrors: ['m1'] }] }, {});
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('ERR_HEAL_BUDGET');
    });
  });

  describe('rebuild-link', () => {
    it('path 目标缺失 → ERR_INSTALL_DEP', async () => {
      const r = await executeAction(makeCore(), { code: 'LINK_FAIL', steps: [{ type: 'rebuild-link' }] }, { plugins: [{ ...npmPlugin('p'), source: { type: 'path', path: '/no/such' } }], profile: tempDir('hs-rl-miss-') });
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('ERR_INSTALL_DEP');
    });
    it('目标存在 → 建链接目录并复制 package.json', async () => {
      const root = tempDir('hs-rl-');
      const target = path.join(root, 'srcp');
      const profile = path.join(root, 'profile');
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'package.json'), '{"name":"srcp"}');
      const r = await executeAction(makeCore(), { code: 'LINK_FAIL', steps: [{ type: 'rebuild-link' }] }, {
        plugins: [{ ...npmPlugin('srcp'), source: { type: 'path', path: target }, installPath: target }],
        profile
      });
      expect(r.ok).toBe(true);
      expect(fs.readFileSync(path.join(profile, 'node_modules', 'srcp', 'package.json'), 'utf8')).toContain('srcp');
      fs.rmSync(root, { recursive: true, force: true });
    });
  });

  describe('reclassify-bundles', () => {
    const mkProfile = (bundles) => {
      const profile = tempDir('hs-rc-');
      fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles } } }));
      return profile;
    };
    it('过滤 patch:false 插件并重写 manifest', async () => {
      const profile = mkProfile(['keep', 'drop']);
      const plugins = [{ name: 'keep', config: { 'dsh.bundle.patch': true } }, { name: 'drop', config: { 'dsh.bundle.patch': false } }];
      const r = await executeAction(makeCore(), { code: 'BUNDLE_MISCLASSIFY', steps: [{ type: 'reclassify-bundles' }] }, { plugins, profile });
      expect(r.ok).toBe(true);
      const m = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'));
      expect(m.dsh.profile.bundles).toEqual(['keep']);
      fs.rmSync(profile, { recursive: true, force: true });
    });
    it('manifest 损坏 → ERR_HEAL_ROLLBACK；无 manifest → ok 跳过', async () => {
      const bad = tempDir('hs-rc-bad-');
      fs.writeFileSync(path.join(bad, 'package.json'), '{bad');
      const r1 = await executeAction(makeCore(), { code: 'BUNDLE_MISCLASSIFY', steps: [{ type: 'reclassify-bundles' }] }, { plugins: [], profile: bad });
      expect(r1.ok).toBe(false);
      expect(r1.error.code).toBe('ERR_HEAL_ROLLBACK');
      const none = tempDir('hs-rc-none-');
      const r2 = await executeAction(makeCore(), { code: 'BUNDLE_MISCLASSIFY', steps: [{ type: 'reclassify-bundles' }] }, { plugins: [], profile: none });
      expect(r2.ok).toBe(true);
      fs.rmSync(bad, { recursive: true, force: true });
      fs.rmSync(none, { recursive: true, force: true });
    });
    it('写失败 → ERR_HEAL_ROLLBACK（C1：写路径不裸抛）', async () => {
      const profile = tempDir('hs-rc-writefail-');
      fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [] } } }));
      const badFs = createFsPort({
        ...fs,
        writeFileSync: () => { throw new Error('EACCES'); }
      });
      const r = await executeAction(makeCore({ ports: { fs: badFs } }), { code: 'BUNDLE_MISCLASSIFY', steps: [{ type: 'reclassify-bundles' }] }, { plugins: [], profile });
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('ERR_HEAL_ROLLBACK');
      fs.rmSync(profile, { recursive: true, force: true });
    });
  });

  describe('regenerate-patch', () => {
    it('成功重写 cordis.patch.yml', async () => {
      const profile = tempDir('hs-rp-');
      const plugins = [npmPlugin('a', '1.0.0', { resolvedVersion: '1.0.0' })];
      const r = await executeAction(makeCore(), { code: 'UTF8_CORRUPTION', steps: [{ type: 'regenerate-patch' }] }, { plugins, profile, state: { id: 'x' } });
      expect(r.ok).toBe(true);
      expect(fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8')).toContain('a');
      fs.rmSync(profile, { recursive: true, force: true });
    });
    it('serialize 失败（M-52：循环引用 config）→ ERR_YAML_SERIALIZE，不裸抛', async () => {
      const profile = tempDir('hs-rp-bad-');
      const loop = { self: null };
      loop.self = loop;
      const plugins = [npmPlugin('a', '1.0.0', { resolvedVersion: '1.0.0', config: { loop } })];
      const r = await executeAction(makeCore(), { code: 'UTF8_CORRUPTION', steps: [{ type: 'regenerate-patch' }] }, { plugins, profile, state: { id: 'x' } });
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('ERR_YAML_SERIALIZE');
      fs.rmSync(profile, { recursive: true, force: true });
    });
    it('写失败 → ERR_YAML_SERIALIZE（C1：写路径不裸抛）', async () => {
      const profile = tempDir('hs-rp-writefail-');
      const badFs = createFsPort({
        ...fs,
        writeFileSync: () => { throw new Error('EACCES'); }
      });
      const plugins = [npmPlugin('a', '1.0.0', { resolvedVersion: '1.0.0' })];
      const r = await executeAction(makeCore({ ports: { fs: badFs } }), { code: 'UTF8_CORRUPTION', steps: [{ type: 'regenerate-patch' }] }, { plugins, profile, state: { id: 'x' } });
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('ERR_YAML_SERIALIZE');
      fs.rmSync(profile, { recursive: true, force: true });
    });
  });

  describe('reprobe-harness', () => {
    it('探测成功 → ok（步骤结果由执行层丢弃，最终只回 ok:true）', async () => {
      const probe = vi.fn(() => ({ ok: true, harness: '/h' }));
      const core = makeCore({ infra: { harness: { findHarness: probe } } });
      const r = await executeAction(core, { code: 'HARNESS_FIX', steps: [{ type: 'reprobe-harness' }] }, {});
      expect(r.ok).toBe(true);
      expect(probe).toHaveBeenCalled();
    });
    it('探测失败 → ERR_HARNESS_NOT_FOUND', async () => {
      const err = new Error('gone');
      err.code = 'ERR_HARNESS_NOT_FOUND';
      const core = makeCore({ infra: { harness: { findHarness: () => ({ ok: false, error: err }) } } });
      const r = await executeAction(core, { code: 'HARNESS_FIX', steps: [{ type: 'reprobe-harness' }] }, {});
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('ERR_HARNESS_NOT_FOUND');
    });
  });

  it('未知步骤 → ERR_HEAL_BUDGET（FIX-16：不静默 ok）', async () => {
    const r = await executeAction(makeCore(), { code: 'X', steps: [{ type: 'time-travel' }] }, {});
    expect(r.ok).toBe(false);
    expect(r.error.message).toContain('未实现的自愈步骤：time-travel');
  });

  it('步骤失败即中断（后续步骤不执行）', async () => {
    let executed = false;
    const r = await executeAction(makeCore(), { code: 'X', steps: [{ type: 'rollback-snapshot' }, { type: 'quarantine' }] }, { state: {}, quarantine: () => { executed = true; return { ok: true }; } });
    expect(r.ok).toBe(false);
    expect(executed).toBe(false);
  });

  it('非 CRASH_LOOP 动作不重置崩溃计数', async () => {
    const state = { launch: { lastExit: 5, retries: 2 }, dirty: false };
    await executeAction(makeCore(), { code: 'UTF8_CORRUPTION', steps: [{ type: 'regenerate-patch' }] }, { state, plugins: [npmPlugin('a', '1.0.0', { resolvedVersion: '1.0.0' })], profile: tempDir('hs-noncrash-') });
    expect(state.launch.lastExit).toBe(5);
    expect(state.dirty).toBe(false);
  });
});

