'use strict';
// test/audit-r5-launch-laststart.test.js — H3b 回归：launch 失败（崩溃退出）也锚定
// lastStart，heal 的 fail-closed 过滤才能分类本次崩溃 stderr（DoD-3「崩溃 → heal 闭环」）。
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers');

describe('H3b：stageLaunch 失败（崩溃退出）也持久化 lastStart', () => {
  it('非零 exit → state.launch.lastStart 已锚定（heal 能分类本次崩溃 stderr）', async () => {
    const { createCore } = require('../app/create-core');
    const { createProcPort } = require('../ports/proc');
    const { STAGES } = require('../app/stages');
    const { EventEmitter } = require('events');
    const { PassThrough } = require('stream');
    const ROOT = path.join(__dirname, '..');
    const home = tempDir('audit-h3b-');
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    env.HOME = home; env.USERPROFILE = home;
    env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
    env.ProgramFiles = path.join(home, 'pf');
    env['ProgramFiles(x86)'] = path.join(home, 'pf86');
    env.PATH = path.join(home, 'bin');
    env.DSH_HOME = path.join(home, '.dsh');
    const hpath = path.join(home, 'AppData', 'Local', 'Programs', 'DSH Desktop', 'DSH Desktop.exe');
    fs.mkdirSync(path.dirname(hpath), { recursive: true });
    fs.writeFileSync(hpath, 'MZ fake harness');
    const core = createCore({
      baseDir: ROOT, home, platform: 'win32', env,
      procPort: createProcPort({ spawn: () => { throw new Error('n/a'); }, spawnSync: () => ({ status: 1, error: null, stderr: '', stdout: '' }) })
    });
    const id = 'audith3b';
    const sb = path.join(ROOT, 'sandbox', '.sandbox', id);
    fs.mkdirSync(path.join(sb, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(sb, 'package.json'), JSON.stringify({ name: 'x', version: '0.1.0', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }));
    fs.writeFileSync(path.join(sb, 'cordis.patch.yml'), '- insert: []\n');
    const state = {
      schemaVersion: 1, id, assemblySha256: null, phase: 'INSTALLED',
      resolved: { plugins: [], conflicts: [], pinnedAt: null },
      install: { status: 'ok', lastExit: 0, nodeModules: false },
      launch: { lastExit: null, lastStart: null, retries: 0, pid: null },
      heal: { history: [], quarantined: [] },
      rollback: { snapshot: null, lastRollbackAt: null }
    };
    let childRef;
    core.ports.proc.spawn = () => {
      childRef = new EventEmitter();
      childRef.stdout = new PassThrough();
      childRef.stderr = new PassThrough();
      childRef.unref = () => {};
      childRef.kill = () => true;
      return childRef;
    };
    const p = STAGES.launch(core, state, { id, wait: true });
    // 崩溃：stderr 打印 Error: ENOENT 后非零退出（DoD-3 形态）
    setTimeout(() => {
      childRef.stderr.write('Error: ENOENT: no such file or directory\n');
      childRef.emit('exit', 3);
    }, 10);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ERR_LAUNCH_EXIT');
    expect(state.launch.lastExit).toBe(3);
    expect(state.launch.lastStart).not.toBeNull();
    expect(Number.isNaN(Date.parse(state.launch.lastStart))).toBe(false);
    fs.rmSync(sb, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
});
