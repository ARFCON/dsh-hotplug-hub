'use strict';
// scripts/qa4-real-env.js — QA4 真实环境进程级验证（三平台可跑）
// 用"假工具链"做最真实场景测试：真实 spawn 子进程、真实文件系统、真实 cmd 包装，
// 但不依赖外网（假 npm / 假 git 由脚本生成，置于隔离 PATH）：
//   1. install npm 降级通道：dsh 缺失 → 假 npm 真实进程 → node_modules 真实落地
//   2. install npm 失败：假 npm 退出 7 → exit=6 + state.install.lastExit=7（childExitCode 透传）
//   3. install github 源：假 git 真实 clone（创建产物）→ 落地 + mirror 链
//   4. win32 .cmd harness：真实 .cmd 经 cmd /d /c 包装启动（isCmdScript 路径）
//   5. 完整链路 assemble→install→launch(--wait)→heal→status
// 隔离红线：HOME/USERPROFILE/PATH 全部指向临时目录；DSH_HOTPLUG_ROOT 指向临时根。
// 用法：node scripts/qa4-real-env.js；退出码：0=全过 1=有失败
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const INDEX = path.join(ROOT, 'index.js');
const ID = 'qa4-real';
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'qa4-home-'));
const QA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'qa4-root-'));
const BIN = path.join(QA_ROOT, 'bin');
const ASSEMBLY_DIR = path.join(QA_ROOT, 'assembly', ID);

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}: ${detail || ''}`); }
}

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  // PATH = 隔离工具链 + 系统必需目录（cmd.exe/where.exe 所在；npm 降级走
  // spawnSync('cmd.exe') 依赖 PATH——完全替换 PATH 会导致 cmd.exe ENOENT）。
  // 假工具链（npm/git）置于最前优先命中；真实 dsh 不在本 PATH 中。
  const sysPath = process.platform === 'win32'
    ? `${process.env.SystemRoot || 'C:\\Windows'}\\System32`
    : '/usr/bin:/bin';
  return {
    ...env,
    DSH_HOTPLUG_ROOT: QA_ROOT,
    HOME,
    USERPROFILE: HOME,
    LOCALAPPDATA: path.join(HOME, 'AppData', 'Local'),
    ProgramFiles: path.join(HOME, 'pf'),
    'ProgramFiles(x86)': path.join(HOME, 'pf86'),
    PATH: BIN + path.delimiter + sysPath,
    DSH_HOME: HOME,
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

/**
 * 生成假工具链（三平台）：
 * - npm：win32=npm.cmd（@echo off + node 假脚本）；POSIX=npm（sh exec node 假脚本）。
 *   假 npm 语义：install 成功时在 cwd（=profile）创建 node_modules/<spec> 并写 package.json；
 *   FAKE_NPM_FAIL=1 时退出 7 且不创建（模拟真实 npm 失败）。
 * - git：win32=git.cmd；POSIX=git。假 git 语义：解析 clone 参数（--branch <ref> <url> <target>），
 *   创建 target 目录 + package.json（模拟真实 clone 产物）；FAKE_GIT_FAIL=1 时退出 128。
 */
function writeFakeTools() {
  fs.mkdirSync(BIN, { recursive: true });
  const nodeBin = process.execPath;
  const fakeNpmJs = path.join(BIN, 'fake-npm.js');
  fs.writeFileSync(fakeNpmJs, [
    "const fs = require('fs');",
    "const path = require('path');",
    "if (process.env.FAKE_NPM_FAIL) process.exit(7);",
    "const argv = process.argv.slice(2);",
    "const spec = argv[argv.length - 1];", // npm install <spec> 的末位参数
    "const name = spec.startsWith('@') ? spec.split('@')[1] : spec.split('@')[0];", // scoped 包兼容
    "const dir = path.join(process.cwd(), 'node_modules', name);",
    "fs.mkdirSync(dir, { recursive: true });",
    "fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '9.9.9' }));",
    "process.exit(0);",
    ''
  ].join('\n'));
  const fakeGitJs = path.join(BIN, 'fake-git.js');
  fs.writeFileSync(fakeGitJs, [
    "const fs = require('fs');",
    "const path = require('path');",
    "if (process.env.FAKE_GIT_FAIL) process.exit(128);",
    "const argv = process.argv.slice(2);", // clone --depth 1 --branch <ref> <url> <target>
    "const target = argv[argv.length - 1];",
    "fs.mkdirSync(target, { recursive: true });",
    "fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name: 'pkg-g', version: '1.0.0' }));",
    "process.exit(0);",
    ''
  ].join('\n'));
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(BIN, 'npm.cmd'), `@echo off\r\n"${nodeBin}" "${fakeNpmJs}" %*\r\n`);
    fs.writeFileSync(path.join(BIN, 'git.cmd'), `@echo off\r\n"${nodeBin}" "${fakeGitJs}" %*\r\n`);
  } else {
    fs.writeFileSync(path.join(BIN, 'npm'), `#!/bin/sh\nexec "${nodeBin}" "${fakeNpmJs}" "$@"\n`);
    fs.writeFileSync(path.join(BIN, 'git'), `#!/bin/sh\nexec "${nodeBin}" "${fakeGitJs}" "$@"\n`);
    fs.chmodSync(path.join(BIN, 'npm'), 0o755);
    fs.chmodSync(path.join(BIN, 'git'), 0o755);
  }
}

/** 假 harness：win32=node 副本（REPL EOF exit 0）；POSIX=sh 包装 exec node。 */
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

/** win32 真实 .cmd harness（置于隔离 BIN）：echo 标记 + 绝对 node 退出 0。
 * 仅在 .cmd 场景写入——第 1-3 节 dsh 通道依赖"BIN 无 dsh.cmd"（dsh 通道失败才降级 npm）。 */
function writeCmdHarness() {
  const hpath = path.join(BIN, 'dsh.cmd');
  fs.mkdirSync(BIN, { recursive: true });
  fs.writeFileSync(hpath, `@echo off\r\necho CMD_HARNESS_ALIVE\r\n"${process.execPath}" -e "process.exit(0)"\r\n`);
  return hpath;
}

function writeAssembly(plugins) {
  fs.mkdirSync(ASSEMBLY_DIR, { recursive: true });
  fs.writeFileSync(path.join(ASSEMBLY_DIR, 'assembly.json'), JSON.stringify({
    hotpack: '1.0', id: ID, name: 'qa4 real env', version: '1.0.0', plugins
  }, null, 2));
}

function cleanup() {
  for (const d of [ASSEMBLY_DIR, HOME, QA_ROOT]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* ok */ }
  }
}

function main() {
  console.log(`== QA4 真实环境进程级（HOME=${HOME}，QA_ROOT=${QA_ROOT}，platform=${process.platform}）==`);
  cleanup();
  writeFakeTools();
  const harnessPath = writeFakeHarness();

  // ---- 1. npm 降级真实链路（dsh 缺失 → 假 npm）----
  writeAssembly([
    { id: 'a', name: 'pkg-a', version: '1.2.3', source: { type: 'npm' }, config: {} },
    { id: 'g', name: 'pkg-g', source: { type: 'github', repo: 'org/repo', ref: 'main' }, config: {} }
  ]);
  let r = cli(['assemble', ID]);
  check('assemble exit=0', r.code === 0, r.stderr.slice(0, 200));

  r = cli(['install', ID]);
  check('install exit=0（假 npm + 假 git 真实子进程）', r.code === 0, `code=${r.code} ${r.stderr.slice(0, 300)}`);
  const sandboxNm = path.join(QA_ROOT, 'sandbox', '.sandbox', ID, 'node_modules');
  check('npm 降级落地：node_modules/pkg-a/package.json', fs.existsSync(path.join(sandboxNm, 'pkg-a', 'package.json')));
  check('github 落地：node_modules/pkg-g/package.json', fs.existsSync(path.join(sandboxNm, 'pkg-g', 'package.json')));

  // ---- 2. 假 npm 失败 → 真实退出码透传 ----
  r = cli(['install', ID], { FAKE_NPM_FAIL: '1' });
  check('假 npm 退出 7 → CLI exit=6（安装域）', r.code === 6, `code=${r.code} ${r.stderr.slice(0, 200)}`);
  const stateFile = path.join(HOME, '.dsh', 'hotplug-store', ID, 'state.json');
  let lastExit = null;
  if (fs.existsSync(stateFile)) {
    const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    lastExit = st.install && st.install.lastExit;
  }
  check('state.install.lastExit=7（childExitCode 真实透传，非契约码）', lastExit === 7, `lastExit=${lastExit}`);
  r = cli(['install', ID]); // 恢复
  check('恢复 install exit=0', r.code === 0, `code=${r.code} ${r.stderr.slice(0, 200)}`);

  // ---- 3. 完整链路：launch --wait（假 harness）→ heal → status ----
  r = cli(['launch', ID, '--wait']);
  check('launch --wait exit=0（假 harness EOF exit 0）', r.code === 0, `code=${r.code} ${r.stderr.slice(0, 200)}`);
  r = cli(['status', ID]);
  check('status exit=0 且 healthy', r.code === 0 && r.stdout.includes('STATUS OK'), `${r.stdout.slice(0, 120)} ${r.stderr.slice(0, 120)}`);
  r = cli(['heal', ID, '--yes']);
  check('heal --yes 可执行（exit=0 有动作 / exit=9 无信号）', r.code === 0 || r.code === 9, `code=${r.code} ${r.stderr.slice(0, 200)}`);

  // ---- 4. win32 .cmd harness 经 cmd /d /c 真实启动 ----
  if (process.platform === 'win32') {
    // 移除候选 exe → findHarness 候选全缺 → where dsh.cmd 回退命中 BIN/dsh.cmd
    try { fs.unlinkSync(harnessPath); } catch (_) { /* ok */ }
    writeCmdHarness(); // 假 dsh.cmd 写入隔离 BIN（PATH 最前，where 必命中）
    r = cli(['launch', ID, '--wait']);
    check('.cmd harness launch exit=0（cmd /d /c 包装真实启动）', r.code === 0, `code=${r.code} ${r.stderr.slice(0, 300)}`);
    const logFile = path.join(QA_ROOT, 'sandbox', '.sandbox', ID, 'logs', 'run.jsonl');
    const logText = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    check('run.jsonl 记录 .cmd 输出 CMD_HARNESS_ALIVE', logText.includes('CMD_HARNESS_ALIVE'), '');
  }

  // ---- 5. 隔离红线 ----
  const realStore = path.join(os.homedir(), '.dsh', 'hotplug-store', ID);
  const realProfile = path.join(os.homedir(), '.dsh', 'profiles', ID);
  check('隔离红线：真实 ~/.dsh 零触碰', !fs.existsSync(realStore) && !fs.existsSync(realProfile));

  cleanup();
  console.log(`\n== 结果：PASS=${pass} FAIL=${fail} ==`);
  process.exit(fail > 0 ? 1 : 0);
}

try {
  main();
} catch (e) {
  console.error('脚本异常：', e);
  cleanup();
  process.exit(2);
}
