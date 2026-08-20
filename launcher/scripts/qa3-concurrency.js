'use strict';
// scripts/qa3-concurrency.js — 并发实测（QA3 第 3 层主题 15）
// 10 并发 assemble（同 id）→ 锁串行化、state 不撕裂；
// 10 并发 launch（同 id）→ 无孤儿进程。
// 上游适配（C6）：DSH_HOTPLUG_ROOT 指向临时根；假 harness 与孤儿检查按平台分支（三平台可跑）。
// 用法：node scripts/qa3-concurrency.js
// 退出码：0=全部通过；1=存在失败项
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const INDEX = path.join(ROOT, 'index.js');
const ID = 'qa3-conc';
const N = 10;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'qa3-conc-home-'));
const QA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'qa3-conc-root-'));
const ASSEMBLY_DIR = path.join(QA_ROOT, 'assembly', ID);
const SANDBOX_DIR = path.join(QA_ROOT, 'sandbox', '.sandbox', ID);
// POSIX 孤儿检查标记：harness 内联代码含唯一标记，ps 可按命令行匹配
const KEEPALIVE_MARKER = 'DHS_KEEPALIVE_9f3c7a';

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { fail += 1; failures.push({ name, detail }); console.log(`  FAIL ${name}: ${detail}`); }
}

// 干净子进程环境：剥离 NODE_OPTIONS（沙箱注入的 shim 会破坏子进程）。
// A2 修复：HOME/USERPROFILE/LOCALAPPDATA/ProgramFiles/PATH/DSH_HOME 必须**强制覆盖**
// （不能用 `env.HOME = env.HOME || HOME` 条件赋值——父进程真实 env 已有这些键，
// 条件赋值会让 CLI 继续使用真实 HOME，触碰真实 ~/.dsh / 真实 dsh CLI）。
// C6 修复：先删 NODE_OPTIONS 再合并 extra——此前 `{...process.env, ...extra}` 后
// delete 会把 extra 里显式传入的 NODE_OPTIONS（如 --require=keepalive）一并删掉，
// 导致假 harness 变回裸 node.exe（REPL EOF ~150ms 退出 < 500ms 存活窗口 →
// 恒 ERR_LAUNCH_DETACH exit=8，并发断言必败）。
// keepPath=true 时保留真实 PATH（孤儿检查需要 powershell/ps）。
function cleanEnv(extra = {}, opts = {}) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  Object.assign(env, extra);
  env.HOME = HOME;
  env.USERPROFILE = HOME;
  env.LOCALAPPDATA = path.join(HOME, 'AppData', 'Local');
  env.ProgramFiles = HOME;
  env['ProgramFiles(x86)'] = HOME;
  env.DSH_HOME = HOME;
  env.DSH_HOTPLUG_ROOT = QA_ROOT;
  if (!opts.keepPath) env.PATH = HOME;
  return env;
}

/**
 * 异步 spawn CLI 并收集输出；带超时（防子进程挂起导致脚本无限等待）。
 * 超时后 SIGTERM→SIGKILL 清理并返回 { code: 'TIMEOUT' }。
 */
function spawnCli(args, envExtra, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, [INDEX, ...args], {
      env: cleanEnv(envExtra),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = ''; let err = ''; let settled = false;
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGTERM'); } catch (_) { /* ok */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { /* ok */ } }, 1000).unref();
      resolve({ code: 'TIMEOUT', out, err });
    }, timeoutMs);
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

function runCli(args, envExtra) {
  const r = spawnSync(process.execPath, [INDEX, ...args], {
    encoding: 'utf8',
    env: cleanEnv(envExtra),
    timeout: 120000
  });
  return r;
}

function writeAssembly(plugins) {
  fs.mkdirSync(ASSEMBLY_DIR, { recursive: true });
  fs.writeFileSync(path.join(ASSEMBLY_DIR, 'assembly.json'), JSON.stringify({
    hotpack: '1.0', id: ID, name: '并发实测', version: '1.0.0', plugins
  }, null, 2));
}

function cleanup() {
  try { fs.rmSync(ASSEMBLY_DIR, { recursive: true, force: true }); } catch (_) { /* ok */ }
  try { fs.rmSync(SANDBOX_DIR, { recursive: true, force: true }); } catch (_) { /* ok */ }
  try { fs.rmSync(path.join(HOME, '.dsh'), { recursive: true, force: true }); } catch (_) { /* ok */ }
  try { fs.rmSync(QA_ROOT, { recursive: true, force: true }); } catch (_) { /* ok */ }
}

/**
 * 按平台放置假 harness（三平台可跑）：
 * - win32：node.exe 副本 + NODE_OPTIONS --require=keepalive（3s 后退出 0）；
 * - POSIX：sh 包装脚本 exec node -e "…KEEPALIVE_MARKER…"（自含常驻代码，
 *   无需 NODE_OPTIONS；stageLaunch 传入的 --profile 参数被忽略）。
 */
function writeKeepaliveHarness(keepalive) {
  const hpath = process.platform === 'win32'
    ? path.join(HOME, 'AppData', 'Local', 'Programs', 'DSH Desktop', 'DSH Desktop.exe')
    : process.platform === 'darwin'
      ? path.join(HOME, 'Applications', 'DSH Desktop.app', 'Contents', 'MacOS', 'DSH Desktop')
      : path.join(HOME, '.local', 'bin', 'dsh');
  fs.mkdirSync(path.dirname(hpath), { recursive: true });
  if (process.platform === 'win32') {
    fs.copyFileSync(process.execPath, hpath);
  } else {
    const code = `setInterval(()=>{},1000);setTimeout(()=>process.exit(0),3000);//${KEEPALIVE_MARKER}`;
    fs.writeFileSync(hpath, '#!/bin/sh\nexec "' + process.execPath + '" -e "' + code + '"\n');
    fs.chmodSync(hpath, 0o755);
  }
  return { hpath, keepalive };
}

/** 统计残留 harness 进程数（win32=按 Path 查进程；POSIX=按命令行标记 grep）。 */
function countHarnessProcs(harnessPath) {
  if (process.platform === 'win32') {
    const ps = spawnSync('powershell.exe', [
      '-NoProfile', '-Command',
      `Get-Process | Where-Object { $_.Path -eq '${harnessPath.replace(/'/g, "''")}' } | Measure-Object | Select-Object -ExpandProperty Count`
    ], { encoding: 'utf8', timeout: 30000, env: cleanEnv({}, { keepPath: true }) });
    const psOut = (ps.stdout || '').trim();
    // A2 修复：powershell 输出为空（命令失败）时必须显式 FAIL，不得 Number('')=0 误报 PASS
    return psOut === '' ? -1 : Number(psOut);
  }
  const ps = spawnSync('sh', ['-c', `ps -eo args | grep -F '${KEEPALIVE_MARKER}' | grep -v grep | wc -l`],
    { encoding: 'utf8', timeout: 30000, env: cleanEnv({}, { keepPath: true }) });
  const psOut = (ps.stdout || '').trim();
  return psOut === '' ? -1 : Number(psOut);
}

async function main() {
  console.log(`== QA3 并发实测（HOME=${HOME}，并发数=${N}）==`);

  // ---------- Part A：10 并发 assemble ----------
  writeAssembly([
    { id: 'a', name: 'pkg-a', version: '1.0.0', source: { type: 'npm' }, config: {} },
    { id: 'b', name: 'pkg-b', version: '2.0.0', source: { type: 'npm' }, config: {} }
  ]);
  const results = await Promise.all(Array.from({ length: N }, () => spawnCli(['assemble', ID], {})));

  const codes = results.map((r) => r.code);
  console.log('  10 并发 assemble 退出码：', codes.join(','));
  const okCount = codes.filter((c) => c === 0).length;
  check(`并发 assemble 全部成功或锁超时（成功 ${okCount}/${N}）`, okCount === N || codes.every((c) => c === 0 || c === 10), codes.join(','));
  const errMsgs = results.filter((r) => r.code !== 0).map((r) => r.err.trim().slice(0, 120));
  if (errMsgs.length) console.log('  非零退出消息：', errMsgs);

  // state 完整性：单进程读回校验
  const stateFile = path.join(HOME, '.dsh', 'hotplug-store', ID, 'state.json');
  check('state.json 存在', fs.existsSync(stateFile), stateFile);
  // 隔离红线回归（A2）：CLI 子进程必须把 state 写到隔离 HOME，
  // 真实用户 HOME 的 ~/.dsh 不得出现本测试的任何条目
  const realStore = path.join(os.homedir(), '.dsh', 'hotplug-store', ID);
  check('隔离红线：真实 ~/.dsh/hotplug-store/<id> 零触碰', !fs.existsSync(realStore), realStore);
  if (fs.existsSync(stateFile)) {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    check('state schemaVersion=1 且 phase=CHECKED', state.schemaVersion === 1 && state.phase === 'CHECKED', JSON.stringify({ schemaVersion: state.schemaVersion, phase: state.phase }));
    check('state.resolved.plugins 完整（2 个）', Array.isArray(state.resolved.plugins) && state.resolved.plugins.length === 2);
    check('state.resolved.plugins 无撕裂（id 唯一）', new Set(state.resolved.plugins.map((p) => p.id)).size === 2);
  }
  // 产物完整性
  const sb = SANDBOX_DIR;
  check('sandbox package.json 存在', fs.existsSync(path.join(sb, 'package.json')));
  check('sandbox cordis.patch.yml 存在', fs.existsSync(path.join(sb, 'cordis.patch.yml')));
  if (fs.existsSync(path.join(sb, 'cordis.patch.yml'))) {
    const YAML = require('yaml');
    try {
      const parsed = YAML.parse(fs.readFileSync(path.join(sb, 'cordis.patch.yml'), 'utf8'));
      check('cordis.patch.yml 可解析且 insert=2', Array.isArray(parsed) && Array.isArray(parsed[0].insert) && parsed[0].insert.length === 2);
    } catch (e) {
      check('cordis.patch.yml 可解析', false, e.message);
    }
  }

  // ---------- Part B：并发 launch 无孤儿 ----------
  // 准备：path 源插件（避免网络）+ 假 harness（node.exe 副本）
  const fakePlugin = path.join(HOME, 'fake-plugins', 'pkg-p');
  fs.mkdirSync(fakePlugin, { recursive: true });
  fs.writeFileSync(path.join(fakePlugin, 'package.json'), JSON.stringify({ name: 'pkg-p', version: '1.0.0' }));
  writeAssembly([
    { id: 'p', name: 'pkg-p', source: { type: 'path', path: fakePlugin }, config: {} }
  ]);
  // 先 assemble + install
  const ra = runCli(['assemble', ID]);
  check('前置 assemble 成功', ra.status === 0, `status=${ra.status} ${ra.stderr}`);
  const ri = runCli(['install', ID]);
  check('前置 install 成功（path 源）', ri.status === 0, `status=${ri.status} ${ri.stderr.slice(0, 200)}`);

  // 假 harness：按平台放置（win32=node 副本+keepalive；POSIX=sh 包装自含常驻代码）。
  // A2 修复：裸 node.exe 副本（REPL EOF）约 150ms 即退出，小于 detach 500ms 存活窗口，
  // 会触发 ERR_LAUNCH_DETACH（exit 8）导致断言必败；keepalive 让 harness 常驻 3s
  //（>500ms 存活窗口），随后自行退出。
  const keepalive = path.join(HOME, 'keepalive.js');
  fs.writeFileSync(keepalive, [
    "setInterval(() => {}, 1000);",
    "setTimeout(() => { process.exit(0); }, 3000);",
    ''
  ].join('\n'));
  const { hpath: harnessPath } = writeKeepaliveHarness(keepalive);

  const launchResults = await Promise.all(Array.from({ length: N }, () =>
    spawnCli(['launch', ID], process.platform === 'win32' ? { NODE_OPTIONS: `--require=${keepalive}` } : {})));
  const lcodes = launchResults.map((r) => r.code);
  console.log('  10 并发 launch 退出码：', lcodes.join(','));
  check('并发 launch 全部 0 或锁超时 10', lcodes.every((c) => c === 0 || c === 10), lcodes.join(','));

  // 无孤儿：等待 20s 后，harness 进程应全部自行退出（keepalive 3s 后退出）
  console.log('  等待 20s 观察孤儿进程…');
  await new Promise((r) => setTimeout(r, 20000));
  const harnessProcs = countHarnessProcs(harnessPath);
  console.log(`  残留 harness 进程数：${harnessProcs}`);
  check('并发 launch 无孤儿 harness 进程', harnessProcs === 0, `count=${harnessProcs}`);

  cleanup();
  console.log(`\n== 结果：PASS=${pass} FAIL=${fail} ==`);
  if (fail > 0) {
    for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('脚本异常：', e);
  cleanup();
  process.exit(2);
});
