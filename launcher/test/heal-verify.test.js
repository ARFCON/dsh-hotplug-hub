'use strict';
// test/heal-verify.test.js — infra/heal-verify.js 全覆盖（C3：无恒通过）
// 每个自愈动作 = 执行 + 验证 + 回滚；verifyAction 十种动作码逐分支、rollbackAction 快照恢复。
const path = require('path');
const fs = require('fs');
const { verifyAction, rollbackAction } = require('../infra/heal-verify');
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
'use strict';
describe('infra/heal-verify.js verifyAction 全动作（C3：无恒通过）', () => {
  describe('INSTALL_FAIL', () => {
    it('全部落地 → ok', async () => {
      const root = tempDir('hv-install-ok-');
      fs.mkdirSync(path.join(root, 'node_modules', 'a'), { recursive: true });
      const r = await verifyAction(makeCore(), { code: 'INSTALL_FAIL' }, { plugins: [npmPlugin('a', '1.0.0', { resolvedVersion: '1.0.0' })], profile: root });
      expect(r).toEqual({ ok: true });
      fs.rmSync(root, { recursive: true, force: true });
    });
    it('缺失 → ERR_INSTALL_DEP 并列出 missing', async () => {
      const root = tempDir('hv-install-fail-');
      const r = await verifyAction(makeCore(), { code: 'INSTALL_FAIL' }, { plugins: [npmPlugin('a', '1.0.0'), npmPlugin('b', '1.0.0')], profile: root });
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('ERR_INSTALL_DEP');
      expect(r.error.message).toContain('a, b');
      fs.rmSync(root, { recursive: true, force: true });
    });
  });

  describe('LINK_FAIL', () => {
    it('path 源已链接 → ok；未链接 → ERR_INSTALL_DEP', async () => {
      const root = tempDir('hv-link-');
      fs.mkdirSync(path.join(root, 'node_modules', 'okp'), { recursive: true });
      const ok = await verifyAction(makeCore(), { code: 'LINK_FAIL' }, { plugins: [{ ...npmPlugin('okp'), source: { type: 'path', path: '/x' } }], profile: root });
      expect(ok.ok).toBe(true);
      const bad = await verifyAction(makeCore(), { code: 'LINK_FAIL' }, { plugins: [{ ...npmPlugin('miss'), source: { type: 'path', path: '/x' } }], profile: root });
      expect(bad.ok).toBe(false);
      expect(bad.error.code).toBe('ERR_INSTALL_DEP');
      fs.rmSync(root, { recursive: true, force: true });
    });
    it('无 path 源插件（npm/github）→ ok', async () => {
      const r = await verifyAction(makeCore(), { code: 'LINK_FAIL' }, { plugins: [npmPlugin('a', '1.0.0'), { ...npmPlugin('g'), source: { type: 'github', ref: 'main' } }], profile: tempDir('hv-link-none-') });
      expect(r.ok).toBe(true);
    });
  });

  describe('CRASH_LOOP', () => {
    it('lastExit null/undefined/0 → ok（C3：detach 成功视为通过）', async () => {
      for (const v of [null, undefined, 0]) {
        const r = await verifyAction(makeCore(), { code: 'CRASH_LOOP' }, { state: { launch: { lastExit: v } } });
        expect(r.ok, `lastExit=${v}`).toBe(true);
      }
    });
    it('lastExit 非 0 → ERR_HEAL_BUDGET 且带 retries', async () => {
      const r = await verifyAction(makeCore(), { code: 'CRASH_LOOP' }, { state: { launch: { lastExit: 3, retries: 2 } } });
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('ERR_HEAL_BUDGET');
      expect(r.error.message).toContain('3');
      expect(r.error.message).toContain('retries=2');
    });
  });

  describe('UTF8_CORRUPTION', () => {
    it('patch 仍含 U+FFFD → ERR_YAML_PARSE', async () => {
      const root = tempDir('hv-utf8-');
      fs.writeFileSync(path.join(root, 'cordis.patch.yml'), 'a: \uFFFD');
      const r = await verifyAction(makeCore(), { code: 'UTF8_CORRUPTION' }, { profile: root });
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('ERR_YAML_PARSE');
      fs.rmSync(root, { recursive: true, force: true });
    });
    it('patch 干净/不存在 → ok', async () => {
      const root = tempDir('hv-utf8-ok-');
      fs.writeFileSync(path.join(root, 'cordis.patch.yml'), 'a: 1');
      expect((await verifyAction(makeCore(), { code: 'UTF8_CORRUPTION' }, { profile: root })).ok).toBe(true);
      const empty = tempDir('hv-utf8-missing-');
      expect((await verifyAction(makeCore(), { code: 'UTF8_CORRUPTION' }, { profile: empty })).ok).toBe(true);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(empty, { recursive: true, force: true });
    });
  });

  describe('VERSION_CONFLICT', () => {
    it('仍冲突 → ERR_CONFLICT_BLOCKED（C3：校验动作修改后的数据）', async () => {
      const plugins = [
        { ...npmPlugin('dup', '^1.0.0'), resolvedVersion: '1.0.0' },
        { ...npmPlugin('dup', '^2.0.0'), resolvedVersion: '2.0.0' }
      ];
      const r = await verifyAction(makeCore(), { code: 'VERSION_CONFLICT' }, { plugins });
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('ERR_CONFLICT_BLOCKED');
    });
    it('无冲突 → ok', async () => {
      const r = await verifyAction(makeCore(), { code: 'VERSION_CONFLICT' }, { plugins: [npmPlugin('a', '^1.0.0', { resolvedVersion: '1.0.0' })] });
      expect(r.ok).toBe(true);
    });
  });

  describe('BUNDLE_MISCLASSIFY', () => {
    const manifest = (bundles) => JSON.stringify({ name: 'x', dsh: { profile: { bundles } } }, null, 2);
    it('manifest 缺失 → ERR_HEAL_ROLLBACK', async () => {
      const r = await verifyAction(makeCore(), { code: 'BUNDLE_MISCLASSIFY' }, { profile: tempDir('hv-bm-missing-'), plugins: [] });
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('ERR_HEAL_ROLLBACK');
    });
    it('manifest 损坏 → ERR_HEAL_ROLLBACK', async () => {
      const root = tempDir('hv-bm-bad-');
      fs.writeFileSync(path.join(root, 'package.json'), '{oops');
      const r = await verifyAction(makeCore(), { code: 'BUNDLE_MISCLASSIFY' }, { profile: root, plugins: [] });
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('ERR_HEAL_ROLLBACK');
      fs.rmSync(root, { recursive: true, force: true });
    });
    it('bundle 仍含 patch:false 插件 → ERR_HEAL_ROLLBACK', async () => {
      const root = tempDir('hv-bm-conflict-');
      fs.writeFileSync(path.join(root, 'package.json'), manifest(['badp']));
      const plugins = [{ name: 'badp', config: { 'dsh.bundle.patch': false } }];
      const r = await verifyAction(makeCore(), { code: 'BUNDLE_MISCLASSIFY' }, { profile: root, plugins });
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('ERR_HEAL_ROLLBACK');
      fs.rmSync(root, { recursive: true, force: true });
    });
    it('bundle 正常/非 bundle 插件 → ok', async () => {
      const root = tempDir('hv-bm-ok-');
      fs.writeFileSync(path.join(root, 'package.json'), manifest(['goodp', 'notinplugins']));
      const plugins = [{ name: 'goodp', config: { 'dsh.bundle.patch': true } }];
      const r = await verifyAction(makeCore(), { code: 'BUNDLE_MISCLASSIFY' }, { profile: root, plugins });
      expect(r.ok).toBe(true);
      fs.rmSync(root, { recursive: true, force: true });
    });
    it('无 dsh.profile.bundles 字段 → ok', async () => {
      const root = tempDir('hv-bm-nobundles-');
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x' }));
      const r = await verifyAction(makeCore(), { code: 'BUNDLE_MISCLASSIFY' }, { profile: root, plugins: [] });
      expect(r.ok).toBe(true);
      fs.rmSync(root, { recursive: true, force: true });
    });
  });

  describe('GITHUB_ACQUIRE_FAIL', () => {
    it('github 插件未落地 → ERR_INSTALL_ACQUIRE；落地 → ok', async () => {
      const root = tempDir('hv-gh-');
      fs.mkdirSync(path.join(root, 'node_modules', 'ghp'), { recursive: true });
      fs.writeFileSync(path.join(root, 'node_modules', 'ghp', 'package.json'), '{}');
      const gh = { ...npmPlugin('ghp'), source: { type: 'github', ref: 'main' } };
      expect((await verifyAction(makeCore(), { code: 'GITHUB_ACQUIRE_FAIL' }, { plugins: [gh], profile: root })).ok).toBe(true);
      const bad = await verifyAction(makeCore(), { code: 'GITHUB_ACQUIRE_FAIL' }, { plugins: [{ ...gh, name: 'ghmiss' }], profile: root });
      expect(bad.ok).toBe(false);
      expect(bad.error.code).toBe('ERR_INSTALL_ACQUIRE');
      fs.rmSync(root, { recursive: true, force: true });
    });
  });

  describe('REGISTRY_UNAVAILABLE', () => {
    it('registry 可用 → ok', async () => {
      const core = makeCore({ ports: { fs: fsPort, registry: { availableVersions: () => ['1.0.0'] } } });
      expect((await verifyAction(core, { code: 'REGISTRY_UNAVAILABLE' }, {})).ok).toBe(true);
    });
    it('registry 抛错 → ERR_INSTALL_ACQUIRE', async () => {
      const core = makeCore({ ports: { fs: fsPort, registry: { availableVersions: () => { throw new Error('ECONNREFUSED'); } } } });
      const r = await verifyAction(core, { code: 'REGISTRY_UNAVAILABLE' }, {});
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('ERR_INSTALL_ACQUIRE');
      expect(r.error.message).toContain('ECONNREFUSED');
    });
    it('无 registry 端口 → ok（空实现视为恢复）', async () => {
      expect((await verifyAction(makeCore(), { code: 'REGISTRY_UNAVAILABLE' }, {})).ok).toBe(true);
    });
  });

  describe('HARNESS_FIX', () => {
    it('重新探测 ok → ok', async () => {
      const core = makeCore({ infra: { harness: { findHarness: () => ({ ok: true, harness: '/h' }) } } });
      expect((await verifyAction(core, { code: 'HARNESS_FIX' }, {})).ok).toBe(true);
    });
    it('重新探测失败 → 透传 probe.error', async () => {
      const probeErr = new Error('no harness');
      probeErr.code = 'ERR_HARNESS_NOT_FOUND';
      const core = makeCore({ infra: { harness: { findHarness: () => ({ ok: false, error: probeErr }) } } });
      const r = await verifyAction(core, { code: 'HARNESS_FIX' }, {});
      expect(r.ok).toBe(false);
      expect(r.error).toBe(probeErr);
    });
  });

  it('未知动作码 → 默认 ok（向后兼容未知动作）', async () => {
    expect(await verifyAction(makeCore(), { code: 'UNKNOWN_FUTURE_ACTION' }, {})).toEqual({ ok: true });
  });
});

describe('infra/heal-verify.js rollbackAction', () => {
  it('无快照/rollback 标记跳过 → ok（不误伤）', async () => {
    const r = await rollbackAction(makeCore(), { code: 'X', rollback: null }, { state: {} });
    expect(r.ok).toBe(true);
    const r2 = await rollbackAction(makeCore(), { code: 'X', rollback: '恢复原 bundles 列表' }, { state: { rollback: { snapshot: { files: [] } } } });
    expect(r2.ok).toBe(true);
  });
  it('有快照 → restoreSnapshot 恢复内容（修改后被还原）', async () => {
    const profile = tempDir('hv-rollback-');
    fs.mkdirSync(path.join(profile, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(profile, 'a.txt'), 'orig-a');
    fs.writeFileSync(path.join(profile, 'sub', 'b.txt'), 'orig-b');
    const snap = createSnapshot(fsPort, profile);
    expect(snap.ok).toBe(true);
    // 篡改 + 新增
    fs.writeFileSync(path.join(profile, 'a.txt'), 'MUTATED');
    fs.writeFileSync(path.join(profile, 'extra.txt'), 'new');
    const r = await rollbackAction(makeCore(), { code: 'X', rollback: '恢复快照' }, { state: { rollback: { snapshot: snap.snapshot } }, profile });
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(profile, 'a.txt'), 'utf8')).toBe('orig-a');
    expect(fs.readFileSync(path.join(profile, 'sub', 'b.txt'), 'utf8')).toBe('orig-b');
    expect(fs.existsSync(path.join(profile, 'extra.txt'))).toBe(false);
    fs.rmSync(profile, { recursive: true, force: true });
  });
  it('restore 失败 → ERR_HEAL_ROLLBACK', async () => {
    // 快照含 external 文件但 externalDir 缺失 → 预验证失败
    const profile = tempDir('hv-rollback-fail-');
    const snapshot = { files: [{ rel: 'x.bin', hash: 'deadbeef', external: true, type: 'file' }], externalDir: null };
    const r = await rollbackAction(makeCore(), { code: 'X', rollback: '恢复快照' }, { state: { rollback: { snapshot } }, profile });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_HEAL_ROLLBACK');
    fs.rmSync(profile, { recursive: true, force: true });
  });
});

