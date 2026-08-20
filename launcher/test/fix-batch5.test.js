'use strict';
// test/fix-batch5.test.js — FIX-19~25 验收（P2 批次）
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { createCore } = require('../app/create-core');
const { createProcPort } = require('../ports/proc');
const { createFsPort } = require('../ports/fs');
const { runPipeline } = require('../app/pipeline');
const { syncProfile } = require('../infra/profile');
const { createRunLog } = require('../infra/runlog');
const { executeAction } = require('../infra/heal');
const { usageResult } = require('../app/commands');
const { parseHotpack } = require('../domain/assembly');
const { createEmptyState } = require('../infra/store');
const { assemblySchema, stateSchema } = require('../contracts/schemas');

const fsPort = createFsPort(fs);

function tempRoots(prefix = 'fix5-') {
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

function writeAssembly(roots, id, plugins) {
  const dir = path.join(roots.assemblyDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'assembly.json'), JSON.stringify({
    hotpack: '1.0', id, name: '示例', version: '1.0.0', plugins
  }));
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

describe('FIX-19/25 缺参退出码 =2 确认', () => {
  it('usageResult exitCode===2 且 code=ERR_ARG_MISSING_ARG', () => {
    const u = usageResult();
    expect(u.code).toBe('ERR_ARG_MISSING_ARG');
    expect(u.exitCode).toBe(2);
  });
});

describe('FIX-20 schemas 消费契约测试', () => {
  it('parseHotpack 产物满足 assemblySchema 关键约束', () => {
    const r = parseHotpack({
      hotpack: '1.0', id: 'example', name: '示例', version: '1.0.0',
      plugins: [
        { id: 'a', name: 'pkg-a', version: '1.2.3', source: { type: 'npm' }, config: { 'dsh.bundle.patch': true } },
        { id: 'b', name: '@scope/pkg-b', source: { type: 'path', path: 'C:/src/b' }, config: {} }
      ]
    });
    expect(r.ok).toBe(true);
    const p = r.pack;
    // assemblySchema: id pattern ^[a-z0-9][a-z0-9._-]{0,63}$
    expect(/^[a-z0-9][a-z0-9._-]{0,63}$/.test(p.id)).toBe(true);
    expect(assemblySchema.required.every((k) => k in p)).toBe(true);
    expect(p.plugins.every((pl) => pl.id && pl.name && pl.source && pl.source.type)).toBe(true);
    expect(assemblySchema.properties.plugins.minItems).toBe(1);
    // name pattern 校验
    expect(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(p.plugins[1].name)).toBe(true);
  });

  it('createEmptyState 满足 stateSchema required（FIX-20 对齐）', () => {
    const s = createEmptyState('demo');
    expect(stateSchema.required.every((k) => k in s)).toBe(true);
    expect(stateSchema.properties.schemaVersion.const).toBe(s.schemaVersion);
  });

  it('schemas 模块被实际消费（SCHEMAS 索引完整）', () => {
    const { SCHEMAS } = require('../contracts/schemas');
    expect(Object.keys(SCHEMAS)).toEqual(expect.arrayContaining(['assembly', 'state', 'cordisPatch', 'runLine', 'commandResult']));
  });
});

describe('FIX-21 heal reclassify-bundles 损坏 manifest 显式报错', () => {
  it('profile package.json 损坏 → ERR_HEAL_ROLLBACK 而非崩溃', async () => {
    const core = createCore({ baseDir: __dirname, home: os.tmpdir() });
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fix21-'));
    fs.writeFileSync(path.join(profile, 'package.json'), '{broken json', 'utf8');
    const action = { code: 'BUNDLE_MISCLASSIFY', steps: [{ type: 'reclassify-bundles' }], budget: 1, rollback: '恢复原 bundles 列表' };
    const r = await executeAction(core, action, { profile, plugins: [], state: {} });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_HEAL_ROLLBACK');
    fs.rmSync(profile, { recursive: true, force: true });
  });
});

describe('FIX-22 只读阶段读取 try/catch', () => {
  it('stageCheck 读取失败（注入 fs 抛错）→ ERR_ASSEMBLY_NOT_FOUND 而非异常', async () => {
    const { roots } = tempRoots();
    writeAssembly(roots, 'example', [{ id: 'a', name: 'pkg-a', version: '1.0.0', source: { type: 'npm' }, config: {} }]);
    const base = coreWith(roots);
    // 注入 readFileSync 抛 EACCES
    const failingFs = { ...base.ports.fs, readFileSync: (p, enc) => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; } };
    const core = { ...base, ports: { ...base.ports, fs: failingFs } };
    const r = await runPipeline(core, 'check', { id: 'example', yes: false, wait: false, timeoutMs: 1000, tail: 50 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ERR_ASSEMBLY_NOT_FOUND');
  });

  it('runlog.list 读取失败 → [] 不抛异常', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix22-'));
    const logFile = path.join(dir, 'run.jsonl');
    fs.writeFileSync(logFile, '{"seq":1}\n');
    // 注入 readFileSync 抛错
    const failingFs = { ...fsPort, readFileSync: () => { throw new Error('EBUSY'); } };
    const log = createRunLog(failingFs, logFile, { now: () => 1000 });
    expect(log.list()).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('FIX-23 syncProfile tmp 残留清理', () => {
  it('rename 失败后无 .tmp 残留', () => {
    const { roots } = tempRoots();
    const core = coreWith(roots);
    const sb = path.join(roots.sandboxRoot, 'example');
    fs.mkdirSync(sb, { recursive: true });
    fs.writeFileSync(path.join(sb, 'package.json'), '{}');
    // 注入 renameSync 抛错（模拟第二次 rename 失败）
    const failingFs = {
      ...core.ports.fs,
      renameSync: (from, to) => {
        const e = new Error('EBUSY'); e.code = 'EBUSY'; throw e;
      }
    };
    const core2 = { ...core, ports: { ...core.ports, fs: failingFs } };
    const r = syncProfile(core2, 'example', { requireHarness: false });
    expect(r.ok).toBe(false);
    const profileDir = path.join(roots.profilesRoot, 'example');
    if (fs.existsSync(profileDir)) {
      const leftovers = fs.readdirSync(profileDir).filter((f) => f.endsWith('.tmp'));
      expect(leftovers).toHaveLength(0);
    }
  });
});

describe('FIX-24 日志写失败 warning 不静默', () => {
  it('append 失败时 launch data 携带 logWarnings', async () => {
    const { base, roots } = tempRoots();
    const plugin = path.join(base, 'fake-plugins', 'pkg-p');
    fs.mkdirSync(plugin, { recursive: true });
    fs.writeFileSync(path.join(plugin, 'package.json'), '{}');
    writeAssembly(roots, 'example', [{ id: 'p', name: 'pkg-p', source: { type: 'path', path: plugin }, config: {} }]);
    const baseCore = coreWith(roots);
    const fakeChild = () => {
      const c = new EventEmitter();
      c.pid = 4242; c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.unref = () => {};
      // 模拟 DSH 输出一行（data 监听注册后触发）
      setTimeout(() => { c.stdout.write(Buffer.from('hello from dsh\n')); }, 50);
      return c;
    };
    const core = {
      ...baseCore,
      ports: {
        ...baseCore.ports,
        proc: createProcPort({ spawn: fakeChild, spawnSync: () => ({ status: 0, error: null, stderr: '', stdout: '' }) })
      }
    };
    const args = { id: 'example', yes: false, wait: false, timeoutMs: 1000, tail: 50 };
    await runPipeline(core, 'assemble', args);
    const inst = await runPipeline(core, 'install', args);
    expect(inst.ok).toBe(true);
    // 注入 appendFileSync 抛错 → 日志写失败 → logWarnings
    const failingFs = { ...core.ports.fs, appendFileSync: () => { throw new Error('ENOSPC'); } };
    const core3 = { ...core, ports: { ...core.ports, fs: failingFs } };
    // sandbox/logs 目录必须存在（assemble 已创建），runLog 创建用 fsPort
    const r = await runPipeline(core3, 'launch', args);
    expect(r.ok).toBe(true);
    expect(Array.isArray(r.data.logWarnings)).toBe(true);
    expect(r.data.logWarnings.length).toBeGreaterThan(0);
  });
});
