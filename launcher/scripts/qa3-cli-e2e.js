'use strict';
// scripts/qa3-cli-e2e.js — CLI 进程级端到端（QA3 第 3 层主题 16）
// 隔离 HOME（USERPROFILE → 临时目录）真实 spawn `node index.js`：
//   全链路 assemble→install→launch(假 harness)→heal→rollback→logs
//   穿越向量 CLI 级全拒 exit=2 / --json 全命令可解析 / 退出码传播 / check/status 目录树 hash 不变
// 上游适配（C6）：DSH_HOTPLUG_ROOT 指向临时根（assembly/sandbox 全落在根下，不触碰仓库）；
//   假 harness 按平台放置（win32=node 副本；POSIX=sh 包装脚本 exec node），三平台可跑（DoD-17）。
// 用法：node scripts/qa3-cli-e2e.js
// 退出码：0=全部通过；1=存在失败项
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const INDEX = path.join(ROOT, 'index.js');
const ID = 'qa3-e2e';
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'qa3-e2e-home-'));
const QA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'qa3-e2e-root-'));
const ASSEMBLY_DIR = path.join(QA_ROOT, 'assembly', ID);
const SANDBOX_DIR = path.join(QA_ROOT, 'sandbox', '.sandbox', ID);

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { fail += 1; failures.push({ name, detail }); console.log(`  FAIL ${name}: ${detail}`); }
}

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS; // 先剥离沙箱 shim，再允许 extra 显式覆盖
  return { ...env, DSH_HOTPLUG_ROOT: QA_ROOT, ...extra };
}

function cli(args, envExtra = {}) {
  const r = spawnSync(process.execPath, [INDEX, ...args], {
    encoding: 'utf8',
    env: cleanEnv({ HOME, USERPROFILE: HOME, LOCALAPPDATA: path.join(HOME, 'AppData', 'Local'), ...envExtra }),
    timeout: 120000
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function dirHash(dir) {
  const out = [];
  (function walk(d) {
    if (!fs.existsSync(d)) return;
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, ent.name);
      if (ent.isDirectory()) walk(abs);
      else if (ent.isFile()) out.push(abs + ':' + crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex'));
    }
  })(dir);
  return crypto.createHash('sha256').update(out.sort().join('\n')).digest('hex');
}

function writeAssembly(plugins) {
  fs.mkdirSync(ASSEMBLY_DIR, { recursive: true });
  fs.writeFileSync(path.join(ASSEMBLY_DIR, 'assembly.json'), JSON.stringify({
    hotpack: '1.0', id: ID, name: 'e2e 实测', version: '1.0.0', plugins
  }, null, 2));
}

/**
 * 按平台放置假 harness（三平台可跑，DoD-17）：
 * - win32：node.exe 副本（REPL EOF 正常退出 0）；
 * - POSIX：sh 包装脚本 exec 真实 node（NODE_OPTIONS 注入的 recorder/keepalive 仍生效；
 *   stageLaunch 传入的 --profile 参数被忽略——假 harness 不校验参数）。
 */
function writeFakeHarness() {
  const hpath = process.platform === 'win32'
    ? path.join(HOME, 'AppData', 'Local', 'Programs', 'DSH Desktop', 'DSH Desktop.exe')
    : process.platform === 'darwin'
      ? path.join(HOME, 'Applications', 'DSH Desktop.app', 'Contents', 'MacOS', 'DSH Desktop')
      : path.join(HOME, '.local', 'bin', 'dsh');
  fs.mkdirSync(path.dirname(hpath), { recursive: true });
  if (process.platform === 'win32') {
    fs.copyFileSync(process.execPath, hpath);
  } else {
    fs.writeFileSync(hpath, '#!/bin/sh\nexec "' + process.execPath + '"\n');
    fs.chmodSync(hpath, 0o755);
  }
  return hpath;
}

function cleanup() {
  try { fs.rmSync(ASSEMBLY_DIR, { recursive: true, force: true }); } catch (_) { /* ok */ }
  try { fs.rmSync(SANDBOX_DIR, { recursive: true, force: true }); } catch (_) { /* ok */ }
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) { /* ok */ }
  try { fs.rmSync(QA_ROOT, { recursive: true, force: true }); } catch (_) { /* ok */ }
}

// QA3 Round3 加固：启动前清理共享 sandbox 残留（FIX-1 junction 会使上次 rmSync 部分失败，
// 残留的 logs/run.jsonl 含陈旧 Error 行会污染本次 heal（heal 无时间过滤读取全部日志）→ 幻影自愈动作）
function cleanupAtStart() {
  cleanup();
}

function main() {
  console.log(`== QA3 CLI 进程级 e2e（HOME=${HOME}，QA_ROOT=${QA_ROOT}）==`);
  cleanupAtStart();

  // 准备：path 源插件（避免真实网络）+ 假 harness
  const fakePlugin = path.join(HOME, 'fake-plugins', 'pkg-p');
  fs.mkdirSync(fakePlugin, { recursive: true });
  fs.writeFileSync(path.join(fakePlugin, 'package.json'), JSON.stringify({ name: 'pkg-p', version: '1.0.0' }));
  const harnessPath = writeFakeHarness();

  writeAssembly([
    { id: 'p', name: 'pkg-p', source: { type: 'path', path: fakePlugin }, config: { 'dsh.bundle.patch': true } }
  ]);

  // ---- 1. 全链路 ----
  let r = cli(['assemble', ID]);
  check('assemble exit=0', r.code === 0, `code=${r.code} ${r.stderr.slice(0, 200)}`);
  check('assemble stdout 含 ASSEMBLE OK', r.stdout.includes('ASSEMBLE OK'));

  // 产物验证：cordis.patch.yml 可被 yaml.parse（A 修复 CLI 级）
  const patchFile = path.join(SANDBOX_DIR, 'cordis.patch.yml');
  if (fs.existsSync(patchFile)) {
    const YAML = require('yaml');
    try {
      const parsed = YAML.parse(fs.readFileSync(patchFile, 'utf8'));
      check('cordis.patch.yml CLI 产物可 yaml.parse', Array.isArray(parsed) && parsed[0].insert[0].name === 'pkg-p');
    } catch (e) {
      check('cordis.patch.yml CLI 产物可 yaml.parse', false, e.message);
    }
  } else {
    check('cordis.patch.yml 存在', false);
  }

  r = cli(['check', ID]);
  check('check exit=0', r.code === 0, `code=${r.code} ${r.stderr.slice(0, 200)}`);

  r = cli(['install', ID]);
  check('install exit=0（path 源）', r.code === 0, `code=${r.code} ${r.stderr.slice(0, 200)}`);
  check('install 后 node_modules/pkg-p 落地', fs.existsSync(path.join(SANDBOX_DIR, 'node_modules', 'pkg-p', 'package.json')));

  // launch --wait：假 harness（node.exe REPL EOF → exit 0）
  r = cli(['launch', ID, '--wait']);
  check('launch --wait exit=0', r.code === 0, `code=${r.code} ${r.stderr.slice(0, 200)}`);
  check('launch stdout 含 LAUNCH OK', r.stdout.includes('LAUNCH OK'));

  // DoD-2 强化：假 harness 记录 cwd/env/args（通过 NODE_OPTIONS --require 注入 recorder）
  // recorder 无条件写固定路径：CLI 自身先加载（覆盖为空记录），harness 后加载（覆盖为真实记录）
  const recorder = path.join(HOME, 'recorder.js');
  const recFile = path.join(HOME, 'rec-dump.json');
  fs.writeFileSync(recorder, [
    "const fs = require('fs');",
    "const path = require('path');",
    `fs.writeFileSync(${JSON.stringify(recFile)}, JSON.stringify({`,
    "  cwd: process.cwd(),",
    "  DSH_PROFILE: process.env.DSH_PROFILE || null,",
    "  argv: process.argv.slice(2)",
    "}));",
    ''
  ].join('\n'));
  const rLaunch2 = cli(['launch', ID, '--wait'], { NODE_OPTIONS: `--require=${recorder}` });
  check('launch（recorder 注入）exit=0', rLaunch2.code === 0, `code=${rLaunch2.code} ${rLaunch2.stderr.slice(0, 200)}`);
  if (fs.existsSync(recFile)) {
    const rec = JSON.parse(fs.readFileSync(recFile, 'utf8'));
    const profileDir = path.join(HOME, '.dsh', 'profiles', ID);
    check('harness cwd = profile 目录（DoD-2）', rec.cwd === profileDir, JSON.stringify(rec));
    check('harness env DSH_PROFILE = id（DoD-2）', rec.DSH_PROFILE === ID, JSON.stringify(rec));
    check('harness args 为数组（win32 空数组）（DoD-2）', Array.isArray(rec.argv), JSON.stringify(rec));
  } else {
    check('harness 记录文件生成（DoD-2 cwd/env/args 证据）', false, `missing ${recFile}`);
  }
  // 清理 recorder 记录
  try { fs.unlinkSync(recFile); } catch (_) { /* ok */ }

  r = cli(['status', ID]);
  check('status exit=0', r.code === 0, `code=${r.code} ${r.stderr.slice(0, 200)}`);

  r = cli(['heal', ID, '--yes']);
  // FIX-7：无故障信号时 heal 返回 ERR_HEAL_NO_ACTION（exit=9）——命令可执行性冒烟接受 0 或 9
  check('heal --yes 可执行（exit=0 有动作 / exit=9 无信号）', r.code === 0 || r.code === 9, `code=${r.code} ${r.stderr.slice(0, 200)}`);

  r = cli(['rollback', ID]);
  check('rollback exit=0（有快照）', r.code === 0, `code=${r.code} ${r.stderr.slice(0, 200)}`);

  r = cli(['logs', ID]);
  check('logs exit=0', r.code === 0, `code=${r.code} ${r.stderr.slice(0, 200)}`);

  // ---- 2. 穿越向量 CLI 级全拒 exit=2 ----
  const vectors = ['../x', '..\\x', 'a/../../../x', 'C:\\Windows', 'CON', 'NUL.txt', '...', 'abc '];
  let vectorOk = true;
  for (const v of vectors) {
    const rr = cli(['status', v]);
    if (rr.code !== 2) { vectorOk = false; console.log(`  向量未拒: ${JSON.stringify(v)} code=${rr.code}`); }
  }
  check('穿越向量 CLI 级全拒 exit=2（8 项）', vectorOk);

  // ---- 3. --json 全命令输出可解析且 CommandResult 5 字段齐全 ----
  // 契约（A2 修复）：成功结果 code==='OK'（string），失败结果 code 为 ERR_* 字符串
  const jsonCmds = [['assemble', ID], ['check', ID], ['status', ID], ['logs', ID]];
  let jsonOk = true;
  for (const cmd of jsonCmds) {
    const rr = cli([...cmd, '--json']);
    let parsed = null;
    try { parsed = JSON.parse(rr.stdout || rr.stderr); } catch (_) { parsed = null; }
    const valid = parsed && typeof parsed.ok === 'boolean' &&
      typeof parsed.code === 'string' &&
      typeof parsed.message === 'string' && 'data' in parsed && typeof parsed.exitCode === 'number' &&
      (parsed.ok ? parsed.code === 'OK' : parsed.code.startsWith('ERR_'));
    if (!valid) { jsonOk = false; console.log(`  --json 解析失败: ${cmd.join(' ')} stdout=${JSON.stringify(rr.stdout.slice(0, 120))}`); }
  }
  check('--json 全命令可解析且契约字段齐全（4 命令，成功 code=OK）', jsonOk);

  // ---- 4. 退出码传播：launch 崩溃/spawn 失败 → exit=8 ----
  // 先确保 phase=INSTALLED（前面 assemble --json 已把 phase 置回 CHECKED）
  cli(['install', ID]);
  // 把假 harness 换成损坏 exe（存在、size>0、非符号链接 → 过 verifyHarness，spawn 抛 UNKNOWN → ERR_LAUNCH_SPAWN exit=8）
  fs.writeFileSync(harnessPath, 'this is not a PE file');
  const rl = cli(['launch', ID, '--wait']);
  check('launch 损坏 exe → exit=8（ERR_LAUNCH_SPAWN 传播）', rl.code === 8, `code=${rl.code} stderr=${rl.stderr.slice(0, 150)}`);
  // 恢复
  writeFakeHarness();

  // 缺参 / 未知命令 → exit=2
  const rNoArg = cli(['assemble']);
  check('缺 id → exit=2（usageResult 契约退出码）', rNoArg.code === 2, `code=${rNoArg.code}`);
  const rUnknown = cli(['frobnicate', 'x']);
  check('未知命令 → exit=2', rUnknown.code === 2, `code=${rUnknown.code}`);

  // ---- 6. DoD-3/5：崩溃 → 退出码 8 → heal 闭环 verified:true（path 源 + 崩溃 harness）----
  // 重新 assemble + install 保证 phase=INSTALLED
  cli(['assemble', ID]);
  cli(['install', ID]);
  // 崩溃 recorder：仅当 cwd 为 profile 目录（即 harness 自身）时打印 Error 并退出 3（CLI 加载时不触发）
  const crashRec = path.join(HOME, 'crash-recorder.js');
  fs.writeFileSync(crashRec, [
    "const path = require('path');",
    "if (process.cwd().split(path.sep).includes('profiles')) {",
    "  console.error('Error: ENOENT: no such file or directory, open \\'C:\\\\missing\\\\x\\'');",
    '  process.exit(3);',
    '}',
    ''
  ].join('\n'));
  writeFakeHarness();
  const rCrash = cli(['launch', ID, '--wait'], { NODE_OPTIONS: `--require=${crashRec}` });
  check('崩溃 launch → CLI exit=8（ERR_LAUNCH_EXIT 传播，DoD-3/12）', rCrash.code === 8, `code=${rCrash.code} stderr=${rCrash.stderr.slice(0, 150)}`);
  // run.jsonl 已记录 stderr 故障行
  const runLogFile = path.join(SANDBOX_DIR, 'logs', 'run.jsonl');
  const logText = fs.existsSync(runLogFile) ? fs.readFileSync(runLogFile, 'utf8') : '';
  check('run.jsonl 记录崩溃 stderr（Error: ENOENT）', logText.includes('Error: ENOENT'), '');
  // heal --yes：classify → LINK_FAIL → rebuild-link（path 源 node_modules 已存在）→ verified:true
  const rHeal = cli(['heal', ID, '--yes']);
  check('heal --yes exit=0（DoD-3 闭环）', rHeal.code === 0, `code=${rHeal.code} stderr=${rHeal.stderr.slice(0, 200)}`);
  const stateFile = path.join(HOME, '.dsh', 'hotplug-store', ID, 'state.json');
  let verifiedEntry = null;
  if (fs.existsSync(stateFile)) {
    const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    verifiedEntry = (st.heal && st.heal.history || []).find((h) => h.verified === true);
  }
  check('state.heal.history 出现 verified:true 修复动作（DoD-3/15）', Boolean(verifiedEntry), verifiedEntry ? JSON.stringify(verifiedEntry) : 'no verified entry');
  // 清理崩溃 recorder 影响（恢复正常 harness）
  writeFakeHarness();

  // 注：C6 CRASH_LOOP 闭环 e2e（3 次崩溃 → heal verified + 隔离消费）已独立为
  // scripts/qa3-cli-e2e-crashloop.js（保持本文件 ≤300 行，DoD-16；CI 串行执行两者）。

  // ---- 5. check/status 前后目录树 hash 不变（只读零副作用） ----
  const before = dirHash(path.join(HOME, '.dsh'));
  cli(['check', ID]);
  cli(['status', ID]);
  cli(['logs', ID]);
  const after = dirHash(path.join(HOME, '.dsh'));
  check('check/status/logs 前后 ~/.dsh 目录树 hash 一致', before === after, `${before} vs ${after}`);

  // ---- 7. 隔离红线回归（A2）：真实用户 HOME 的 ~/.dsh 不得出现本测试条目 ----
  const realStore = path.join(os.homedir(), '.dsh', 'hotplug-store', ID);
  const realProfile = path.join(os.homedir(), '.dsh', 'profiles', ID);
  check('隔离红线：真实 ~/.dsh 零触碰（store/profile）', !fs.existsSync(realStore) && !fs.existsSync(realProfile), `${realStore} / ${realProfile}`);

  cleanup();
  console.log(`\n== 结果：PASS=${pass} FAIL=${fail} ==`);
  if (fail > 0) {
    for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  process.exit(0);
}

try {
  main();
} catch (e) {
  console.error('脚本异常：', e);
  cleanup();
  process.exit(2);
}
