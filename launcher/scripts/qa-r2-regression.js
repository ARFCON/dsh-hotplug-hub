'use strict';
// QA 第2轮回归复验脚本（独立验证，不经测试套件）
const path = require('path');
const os = require('os');
const fs = require('fs');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { createCore } = require('../app/create-core');
const { createProcPort } = require('../ports/proc');
const { createFsPort } = require('../ports/fs');
const { runPipeline } = require('../app/pipeline');
const { createRunLog } = require('../infra/runlog');
const { makeError, exitCodeForCode } = require('../contracts/errors');

function fakeChild(pid) {
  const c = new EventEmitter();
  c.pid = pid; c.stdout = new PassThrough(); c.stderr = new PassThrough();
  c.unref = () => { c.unrefCalled = true; };
  return c;
}

function makeCore(spawnFn, assemblyPlugins) {
  return makeCoreWithDsh(spawnFn, assemblyPlugins, async () => ({ ok: false }));
}

function makeCoreWithDsh(spawnFn, assemblyPlugins, pluginAddFn) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa2-'));
  const home = path.join(baseDir, 'home');
  createdDirs.push(baseDir);
  fs.mkdirSync(path.join(baseDir, 'assembly', 'example'), { recursive: true });
  fs.writeFileSync(path.join(baseDir, 'assembly', 'example', 'assembly.json'), JSON.stringify({
    hotpack: '1.0', id: 'example', name: 'p', version: '1.0.0',
    plugins: assemblyPlugins || [{ id: 'a', name: 'pkg-a', version: '1.0.0', source: { type: 'npm' }, config: {} }]
  }));
  const core = createCore({
    baseDir, home,
    procPort: createProcPort({ spawn: spawnFn, spawnSync: () => ({ status: 1, error: null, stderr: '', stdout: '' }) }),
    fsPort: createFsPort(fs),
    dshPort: { findHarness: () => ({ ok: true, harness: 'fake-dsh' }), verifyHarness: () => ({ ok: true }), pluginAdd: pluginAddFn, isInstalled: () => false }
  });
  return { core, baseDir, home };
}

const results = [];
const createdDirs = [];
function check(name, cond, detail) {
  results.push({ name, pass: cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`);
}

// 清理所有临时目录（A2 修复：原先 %TEMP% 每次运行残留 qa2-* 目录）
function cleanupAll() {
  for (const d of createdDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* ok */ }
  }
}

(async () => {
  // === 回归1: launch 崩溃 → CLI exitCode=8（ERR_LAUNCH_EXIT 契约）===
  // 设计意图：launch 需先 install（state-machine.test.js:28-29 CHECKED 拒绝），
  // 故此处先 assemble→install（注入 dsh pluginAdd 成功）→launch。
  {
    const { core } = makeCoreWithDsh(() => {
      const c = fakeChild(8888);
      setTimeout(() => c.emit('exit', 1, null), 10);
      return c;
    }, undefined, async () => ({ ok: true }));
    await runPipeline(core, 'assemble', { id: 'example' });
    const inst = await runPipeline(core, 'install', { id: 'example' });
    check('R0 install 前置成功(状态机launch前置)', inst.ok, `ok=${inst.ok} code=${inst.code}`);
    const r = await runPipeline(core, 'launch', { id: 'example', wait: true, timeoutMs: 3000 });
    check('R1 launch崩溃 exitCode=8(非1)', r.exitCode === 8 && r.code === 'ERR_LAUNCH_EXIT', `code=${r.code} exitCode=${r.exitCode}`);
    // 单测级：makeError 契约
    const e = makeError('ERR_LAUNCH_EXIT', 'x', { childExitCode: 1, signal: null });
    check('R1b makeError ERR_LAUNCH_EXIT 恒8', e.exitCode === 8 && e.childExitCode === 1, `exitCode=${e.exitCode} childExitCode=${e.childExitCode}`);
  }

  // === 回归2: runlog 跨进程 seq 连续 ===
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa2-log-'));
    const file = path.join(dir, 'run.jsonl');
    const fsp = createFsPort(fs);
    const log1 = createRunLog(fsp, file, { now: () => 1000 });
    log1.append({ stream: 'stdout', line: 'l1' });
    log1.append({ stream: 'stdout', line: 'l2' });
    const log2 = createRunLog(fsp, file, { now: () => 2000 });
    const r = log2.append({ stream: 'stdout', line: 'l3' });
    const all = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((x) => JSON.parse(x).seq);
    check('R2 runlog跨进程seq连续(3)', r.seq === 3 && JSON.stringify(all) === '[1,2,3]', `seq=${r.seq} all=${JSON.stringify(all)}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // === 回归3: reassemble 移除插件 → 残留消失且产物保留 ===
  {
    const { core, baseDir, home } = makeCore(() => fakeChild(1), [
      { id: 'a', name: 'pkg-a', version: '1.0.0', source: { type: 'npm' }, config: {} },
      { id: 'b', name: 'pkg-b', version: '2.0.0', source: { type: 'npm' }, config: {} }
    ]);
    await runPipeline(core, 'assemble', { id: 'example' });
    const sbDir = path.join(baseDir, 'sandbox', '.sandbox', 'example');
    // 模拟 install 产生的残留（移除插件 pkg-b 后仍存在的 node_modules）
    fs.mkdirSync(path.join(sbDir, 'node_modules', 'pkg-b'), { recursive: true });
    fs.writeFileSync(path.join(sbDir, 'node_modules', 'pkg-b', 'index.js'), '// stale');
    fs.mkdirSync(path.join(sbDir, 'node_modules', 'pkg-a'), { recursive: true });
    fs.writeFileSync(path.join(sbDir, 'node_modules', 'pkg-a', 'index.js'), '// fresh');
    fs.writeFileSync(path.join(sbDir, 'stale-root.txt'), 'stale');
    fs.mkdirSync(path.join(sbDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(sbDir, 'logs', 'run.jsonl'), '{"seq":1}\n');
    // 修改 assembly：移除 pkg-b
    fs.writeFileSync(path.join(baseDir, 'assembly', 'example', 'assembly.json'), JSON.stringify({
      hotpack: '1.0', id: 'example', name: 'p', version: '1.0.0',
      plugins: [{ id: 'a', name: 'pkg-a', version: '1.0.0', source: { type: 'npm' }, config: {} }]
    }));
    const r2 = await runPipeline(core, 'assemble', { id: 'example' });
    const pkgAExists = fs.existsSync(path.join(sbDir, 'node_modules', 'pkg-a', 'index.js'));
    const pkgBExists = fs.existsSync(path.join(sbDir, 'node_modules', 'pkg-b', 'index.js'));
    const staleRoot = fs.existsSync(path.join(sbDir, 'stale-root.txt'));
    const manifestExists = fs.existsSync(path.join(sbDir, 'package.json'));
    const patchExists = fs.existsSync(path.join(sbDir, 'cordis.patch.yml'));
    const logsExists = fs.existsSync(path.join(sbDir, 'logs', 'run.jsonl'));
    check('R3 reassemble 移除插件残留消失', r2.ok && !pkgBExists && !staleRoot, `removed=${JSON.stringify(r2.data && r2.data.cleaned)}`);
    // 设计预期：assemble 清理整个 node_modules（含仍存在插件的），由后续 install 重建（sandbox-cleanup.test.js:63）
    const nodeModulesGone = !fs.existsSync(path.join(sbDir, 'node_modules'));
    check('R3b 产物与保留项保留(设计:node_modules归零)', manifestExists && patchExists && logsExists && nodeModulesGone, `manifest=${manifestExists} patch=${patchExists} logs=${logsExists} nodeModulesGone=${nodeModulesGone}`);
    // 越界防护：cleanupResidue 不得触碰 sandbox 外（A2 修复：先放置哨兵文件再断言其仍在——
    // 原实现从不创建哨兵，`!outside` 恒真，属空断言）
    fs.mkdirSync(home, { recursive: true });
    const sentinel = path.join(home, 'something.txt');
    fs.writeFileSync(sentinel, 'sentinel');
    const r3c = await runPipeline(core, 'assemble', { id: 'example' });
    const outside = fs.existsSync(sentinel);
    check('R3c 越界防护(sandbox外零变更)', r3c.ok && outside, `ok=${r3c.ok} sentinelExists=${outside}`);
    fs.rmSync(baseDir, { recursive: true, force: true });
  }

  // === 附加: 状态机命令流水线 ===
  {
    const { assertCommandPipeline, STATES, COMMAND_PIPELINES } = require('../contracts/state-machine');
    const a1 = assertCommandPipeline(STATES.IDLE, 'assemble');
    const a2 = assertCommandPipeline(STATES.CHECKED, 'assemble');
    const a3 = assertCommandPipeline(STATES.CHECKED, 'install');
    const a4 = assertCommandPipeline(STATES.IDLE, 'launch');
    check('SM1 assemble从IDLE/CHECKED均可', a1.ok && a2.ok, `IDLE=${a1.ok} CHECKED=${a2.ok} landing=${a1.info && a1.info.landing}`);
    check('SM2 install须先assemble(落CHECKED)', a3.ok, `ok=${a3.ok}`);
    check('SM3 launch从IDLE拒绝', !a4.ok, `ok=${a4.ok}`);
    check('SM4 命令流水线定义齐全', ['assemble','install','launch','heal','rollback'].every((c) => COMMAND_PIPELINES[c]), Object.keys(COMMAND_PIPELINES).join(','));
  }

  const failed = results.filter((r) => !r.pass);
  cleanupAll();
  console.log(`\n===== 回归复验: ${results.length - failed.length}/${results.length} 通过 =====`);
  process.exit(failed.length > 0 ? 1 : 0);
})().catch((e) => {
  cleanupAll();
  console.error('脚本异常：', e);
  process.exit(2);
});
