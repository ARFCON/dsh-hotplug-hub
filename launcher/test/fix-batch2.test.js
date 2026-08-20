'use strict';
// test/fix-batch2.test.js — FIX-6~9 验收（契约与兼容）
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../app/create-core');
const { createProcPort } = require('../ports/proc');
const { runPipeline } = require('../app/pipeline');
const { parseHotpack } = require('../domain/assembly');
const { migrateState, readState } = require('../infra/store');
const { STATES, canTransition, assertCommandPipeline } = require('../contracts/state-machine');
const { createFsPort } = require('../ports/fs');

const fsPort = createFsPort(fs);

function tempRoots(prefix = 'fix2-') {
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

function writeAssembly(roots, id, obj) {
  const dir = path.join(roots.assemblyDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'assembly.json'), JSON.stringify(obj, null, 2));
}

function coreWith(roots) {
  const core = createCore({
    roots,
    procPort: createProcPort({ spawn: () => { throw new Error('no spawn'); }, spawnSync: () => ({ status: 0, error: null, stderr: '', stdout: '' }) }),
    dshPort: { findHarness: () => ({ ok: true, harness: 'fake-dsh' }), verifyHarness: () => ({ ok: true }), pluginAdd: async () => ({ ok: false }), isInstalled: () => false }
  });
  core.infra.harness.findHarness = () => ({ ok: true, harness: 'fake-dsh' });
  return core;
}

describe('FIX-6 legacy assembly 双格式', () => {
  it('legacy（packId/bundles，无 hotpack）解析成功且产物合法', () => {
    const legacy = {
      packId: 'old-pack', name: '旧组合', version: '1.0.0', description: 'd',
      bundles: [
        { id: 'a', package: 'pkg-a', version: '1.2.3', source: { type: 'npm' }, config: {} }
      ]
    };
    const r = parseHotpack(legacy);
    expect(r.ok).toBe(true);
    expect(r.pack.id).toBe('old-pack');
    expect(r.pack.plugins).toHaveLength(1);
    expect(r.pack.plugins[0].name).toBe('pkg-a');
    expect(r.pack.plugins[0].version).toBe('1.2.3');
  });

  it('legacy 缺 version 拒绝（不注入 0.0.1，N38）', () => {
    const r = parseHotpack({ packId: 'x', name: 'x', bundles: [{ package: 'pkg-a' }] });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_ASSEMBLY_FIELD');
  });

  it('legacy 缺 name 拒绝（不再静默造数）', () => {
    const r = parseHotpack({ packId: 'x', version: '1.0.0', bundles: [{ package: 'pkg-a', version: '1.0.0' }] });
    expect(r.ok).toBe(false);
  });

  it('legacy 经 pipeline assemble 成功', async () => {
    const { roots } = tempRoots();
    writeAssembly(roots, 'legacy', {
      packId: 'legacy', name: '旧组合', version: '1.0.0',
      bundles: [{ id: 'a', package: 'pkg-a', version: '1.0.0', source: { type: 'npm' }, config: {} }]
    });
    const core = coreWith(roots);
    const r = await runPipeline(core, 'assemble', { id: 'legacy', yes: false, wait: false, timeoutMs: 1000, tail: 50 });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(roots.sandboxRoot, 'legacy', 'package.json'))).toBe(true);
  });
});

describe('FIX-7 heal 无信号 ERR_HEAL_NO_ACTION', () => {
  it('无 run.jsonl 信号 → exit 9 且 code=ERR_HEAL_NO_ACTION', async () => {
    const { roots } = tempRoots();
    writeAssembly(roots, 'example', {
      hotpack: '1.0', id: 'example', name: '示例', version: '1.0.0',
      plugins: [{ id: 'a', name: 'pkg-a', version: '1.0.0', source: { type: 'npm' }, config: {} }]
    });
    const core = coreWith(roots);
    const args = { id: 'example', yes: true, wait: false, timeoutMs: 1000, tail: 50 };
    await runPipeline(core, 'assemble', args);
    const r = await runPipeline(core, 'heal', args);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ERR_HEAL_NO_ACTION');
    expect(r.exitCode).toBe(9);
  });
});

describe('FIX-8 状态机补全可达性', () => {
  it('QUARANTINED→INSTALLED / ROLLED_BACK→INSTALLED / MONITORING→FAILED / FAILED→IDLE / HEALING→SYNCED 均可转移', () => {
    expect(canTransition(STATES.QUARANTINED, STATES.INSTALLED)).toBe(true);
    expect(canTransition(STATES.ROLLED_BACK, STATES.INSTALLED)).toBe(true);
    expect(canTransition(STATES.MONITORING, STATES.FAILED)).toBe(true);
    expect(canTransition(STATES.FAILED, STATES.IDLE)).toBe(true);
    expect(canTransition(STATES.HEALING, STATES.SYNCED)).toBe(true);
  });

  it('QUARANTINED 经 install 命令可恢复（手册：用户确认移除后重新安装）', () => {
    expect(assertCommandPipeline(STATES.QUARANTINED, 'install').ok).toBe(true);
    expect(assertCommandPipeline(STATES.ROLLED_BACK, 'install').ok).toBe(true);
  });
});

describe('FIX-9 state 迁移策略', () => {
  it('schemaVersion=1 直接通过', () => {
    const r = migrateState({ schemaVersion: 1, id: 'x' });
    expect(r.ok).toBe(true);
    expect(r.state.schemaVersion).toBe(1);
  });

  it('schemaVersion=2（未知高版本）明确拒绝', () => {
    const r = migrateState({ schemaVersion: 2, id: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error.message).toContain('高于当前支持版本');
  });

  it('schemaVersion=0（旧态）升级到 1', () => {
    const r = migrateState({ schemaVersion: 0, id: 'x' });
    expect(r.ok).toBe(true);
    expect(r.state.schemaVersion).toBe(1);
  });

  it('readState 对高版本 state 文件返回错误（不静默使用）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix9-'));
    const file = path.join(dir, 'state.json');
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 99 }));
    const r = readState(fsPort, file);
    expect(r.ok).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
