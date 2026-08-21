'use strict';
// scripts/qa3-cli-e2e-crashloop.js — C6：CRASH_LOOP 自愈闭环 CLI 级端到端
// 连续 3 次崩溃 → heal --yes → verified:true + 崩溃计数重置 + 隔离消费
// （quarantine 后 profile 产物排除被隔离插件；成功 launch 后 retries 清零）。
// 独立脚本（自备隔离 HOME/假 harness），与 qa3-cli-e2e.js 并行构成完整 CLI e2e。
// 上游适配（C6）：DSH_HOTPLUG_ROOT 指向临时根；假 harness 按平台放置（三平台可跑）。
// 用法：node scripts/qa3-cli-e2e-crashloop.js
// 退出码：0=全部通过；1=存在失败项
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const INDEX = path.join(ROOT, 'index.js');
const ID = 'qa3-e2e-cl';
const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa3-e2e-cl-home-')));
const QA_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa3-e2e-cl-root-')));
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
  return {
    ...env,
    HOME,
    USERPROFILE: HOME,
    LOCALAPPDATA: path.join(HOME, 'AppData', 'Local'),
    ProgramFiles: path.join(HOME, 'pf'),
    'ProgramFiles(x86)': path.join(HOME, 'pf86'),
    PATH: path.join(HOME, 'bin'),
    DSH_HOME: path.join(QA_ROOT, '.dsh'),
    DSH_HOTPLUG_ROOT: QA_ROOT,
    ...extra
  };
}

function cli(args, envExtra = {}) {
  const r = spawnSync(process.execPath, [INDEX, ...args], {
    encoding: 'utf8',
    env: cleanEnv(envExtra),
    timeout: 120000
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function writeAssembly(plugins) {
  fs.mkdirSync(ASSEMBLY_DIR, { recursive: true });
  fs.writeFileSync(path.join(ASSEMBLY_DIR, 'assembly.json'), JSON.stringify({
    hotpack: '1.0', id: ID, name: 'crash loop e2e', version: '1.0.0', plugins
  }, null, 2));
}

/**
 * 按平台放置假 harness（win32=node 副本；POSIX=sh 包装 exec node）。
 * NODE_OPTIONS 注入的 recorder 经 env 继承仍生效（POSIX 下 sh → exec node 同进程）。
 * H-1（v5 阶段 1）：DSH_HOTPLUG_ROOT=QA_ROOT 时 CLI 的 config.home = QA_ROOT →
 * findHarness 候选基于 QA_ROOT（Linux/macOS）——只放 HOME 在 CI（无真实 DSH）上
 * 找不到（本机 Windows 靠 LOCALAPPDATA 候选命中而假绿）。POSIX 双放 HOME 与 QA_ROOT。
 */
function writeFakeHarness() {
  const winPath = path.join(HOME, 'AppData', 'Local', 'Programs', 'DSH Desktop', 'DSH Desktop.exe');
  const posixHome = process.platform === 'darwin'
    ? [path.join(HOME, 'Applications', 'DSH Desktop.app', 'Contents', 'MacOS', 'DSH Desktop')]
    : [path.join(HOME, '.local', 'bin', 'dsh'), path.join(HOME, 'Applications', 'DSH Desktop', 'dsh')];
  const posixRoot = process.platform === 'darwin'
    ? [path.join(QA_ROOT, 'Applications', 'DSH Desktop.app', 'Contents', 'MacOS', 'DSH Desktop')]
    : [path.join(QA_ROOT, '.local', 'bin', 'dsh'), path.join(QA_ROOT, 'Applications', 'DSH Desktop', 'dsh')];
  const targets = process.platform === 'win32' ? [winPath] : [...posixHome, ...posixRoot];
  let hpath = targets[0];
  for (const t of targets) {
    fs.mkdirSync(path.dirname(t), { recursive: true });
    if (process.platform === 'win32') {
      fs.copyFileSync(process.execPath, t);
    } else {
      fs.writeFileSync(t, '#!/bin/sh\nexec "' + process.execPath + '"\n');
      fs.chmodSync(t, 0o755);
    }
  }
  return hpath;
}

function cleanup() {
  try { fs.rmSync(ASSEMBLY_DIR, { recursive: true, force: true }); } catch (_) { /* ok */ }
  try { fs.rmSync(SANDBOX_DIR, { recursive: true, force: true }); } catch (_) { /* ok */ }
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) { /* ok */ }
  try { fs.rmSync(QA_ROOT, { recursive: true, force: true }); } catch (_) { /* ok */ }
}

function main() {
  console.log(`== QA3 CLI CRASH_LOOP 闭环 e2e（HOME=${HOME}，QA_ROOT=${QA_ROOT}）==`);
  cleanup();

  // 准备：path 源插件（离线可安装）+ 假 harness（node.exe 副本）+ 崩溃 recorder
  const fakePlugin = path.join(HOME, 'plugins', 'pkg-p');
  fs.mkdirSync(fakePlugin, { recursive: true });
  fs.writeFileSync(path.join(fakePlugin, 'package.json'), JSON.stringify({ name: 'pkg-p', version: '1.0.0' }));
  const harnessPath = writeFakeHarness();
  const crashRec = path.join(HOME, 'crash-recorder.js');
  fs.writeFileSync(crashRec, [
    "const path = require('path');",
    "if (process.cwd().split(path.sep).includes('profiles')) {",
    "  console.error('Error: EACCES: permission denied, open \\'C:\\\\boom\\\\x\\'');",
    '  process.exit(3);',
    '}',
    ''
  ].join('\n'));

  writeAssembly([
    { id: 'p', name: 'pkg-p', source: { type: 'path', path: fakePlugin }, config: {} }
  ]);

  let r = cli(['assemble', ID]);
  check('assemble exit=0', r.code === 0, `code=${r.code} ${r.stderr.slice(0, 120)}`);
  r = cli(['install', ID]);
  check('install exit=0', r.code === 0, `code=${r.code} ${r.stderr.slice(0, 120)}`);

  // 连续 3 次崩溃（--wait，recorder 在 profile cwd 下退出 3）
  for (let i = 1; i <= 3; i += 1) {
    const rr = cli(['launch', ID, '--wait'], { NODE_OPTIONS: `--require=${crashRec}` });
    check(`崩溃 launch #${i} → exit=8`, rr.code === 8, `code=${rr.code}`);
  }
  const stateFile = path.join(QA_ROOT, '.dsh', 'hotplug-store', ID, 'state.json');
  let st = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
  check('3 次崩溃后 retries===3', st && st.launch.retries === 3, `retries=${st && st.launch.retries}`);
  check('lastExit 存真实子进程退出码 3', st && st.launch.lastExit === 3, `lastExit=${st && st.launch.lastExit}`);

  // heal --yes：CRASH_LOOP 动作（回滚快照 + 禁用最近插件）→ verified:true
  const rh = cli(['heal', ID, '--yes']);
  const st2 = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
  const verified = st2 && (st2.heal.history || []).find((h) => h.code === 'CRASH_LOOP' && h.verified === true);
  check('heal --yes exit=0（C6 闭环）', rh.code === 0, `code=${rh.code} stderr=${rh.stderr.slice(0, 200)}`);
  check('CRASH_LOOP history 出现 verified:true', Boolean(verified), JSON.stringify(st2 && st2.heal.history).slice(0, 300));
  check('lastExit 已重置（fresh start）', st2 && (st2.launch.lastExit === null || st2.launch.lastExit === 0), `lastExit=${st2 && st2.launch.lastExit}`);
  check('隔离列表含最近插件 pkg-p', st2 && (st2.heal.quarantined || []).includes('pkg-p'), JSON.stringify(st2 && st2.heal.quarantined));

  // 隔离消费：再次 launch（recorder 仍崩溃，但同步阶段已排除 pkg-p）→ profile 产物不含 pkg-p
  cli(['launch', ID, '--wait'], { NODE_OPTIONS: `--require=${crashRec}` });
  const profilePkg = path.join(QA_ROOT, '.dsh', 'profiles', ID, 'package.json');
  const pkgJson = fs.existsSync(profilePkg) ? JSON.parse(fs.readFileSync(profilePkg, 'utf8')) : null;
  check('profile package.json 排除 pkg-p', pkgJson && !(pkgJson.dependencies || {}).hasOwnProperty('pkg-p'), JSON.stringify(pkgJson && pkgJson.dependencies));
  const profilePatch = path.join(QA_ROOT, '.dsh', 'profiles', ID, 'cordis.patch.yml');
  const patchText = fs.existsSync(profilePatch) ? fs.readFileSync(profilePatch, 'utf8') : '';
  check('profile cordis.patch.yml 排除 pkg-p', !patchText.includes('pkg-p'), patchText.slice(0, 200));

  // 正常 harness 成功 launch → retries 清零（连续失败语义）
  writeFakeHarness();
  const rq = cli(['launch', ID, '--wait']);
  check('恢复正常后 launch exit=0', rq.code === 0, `code=${rq.code} stderr=${rq.stderr.slice(0, 200)}`);
  const st3 = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
  check('成功 launch 后 retries 清零', st3 && st3.launch.retries === 0, `retries=${st3 && st3.launch.retries}`);

  // 隔离红线：真实 ~/.dsh 零触碰
  const realStore = path.join(os.homedir(), '.dsh', 'hotplug-store', ID);
  const realProfile = path.join(os.homedir(), '.dsh', 'profiles', ID);
  check('隔离红线：真实 ~/.dsh 零触碰', !fs.existsSync(realStore) && !fs.existsSync(realProfile), '');

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
