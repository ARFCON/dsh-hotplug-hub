'use strict';
// QA 第2轮 CLI 冒烟（隔离 HOME）：assemble→check→status→logs + launch 前置变化 + 穿越向量
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const smoke = fs.mkdtempSync(path.join(os.tmpdir(), 'qa2-cli-'));
const home = path.join(smoke, 'home');
fs.mkdirSync(path.join(home), { recursive: true });

// 隔离红线（A2 修复）：与 qa3 脚本同一套 cleanEnv 规范——
// 剥离 NODE_OPTIONS，并把 HOME/USERPROFILE/LOCALAPPDATA/ProgramFiles/PATH/DSH_HOME
// 全部指向临时目录，杜绝 findHarness/findDshCli 探测或执行真实 dsh CLI。
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: home,
    ProgramFiles: home,
    'ProgramFiles(x86)': home,
    DSH_HOME: home,
    PATH: home,
    ...extra
  };
}

function run(args, timeout = 30000) {
  const r = spawnSync(process.execPath, [path.join(root, 'index.js'), ...args], {
    cwd: root,
    env: cleanEnv(),
    encoding: 'utf8',
    timeout
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: cond });
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`);
}

(async () => {
  // 1. assemble example
  const a = run(['assemble', 'example']);
  check('CLI assemble example exit=0', a.code === 0, `code=${a.code} out=${a.stdout.split('\n')[0]}`);
  // 2. check example（只读）
  const c = run(['check', 'example']);
  check('CLI check example exit=0', c.code === 0, `code=${c.code} out=${c.stdout.split('\n')[0]}`);
  // 3. status example
  const s = run(['status', 'example']);
  check('CLI status example exit=0', s.code === 0, `code=${s.code}`);
  // 4. logs example
  const l = run(['logs', 'example', '--tail', '3']);
  check('CLI logs example exit=0', l.code === 0, `code=${l.code}`);
  // 5. launch example（未 install，设计上应 ERR_ENV_UNSUPPORTED exit=12 —— 行为变化记录）
  const lc = run(['launch', 'example', '--wait']);
  const launchBlocked = lc.code === 12 && (lc.stderr || lc.stdout).includes('前置命令');
  check('CLI launch 未install 前置拒绝(设计行为, exit=12)', launchBlocked, `code=${lc.code} msg=${(lc.stderr || lc.stdout).split('\n')[0]}`);
  // 6. 穿越向量 CLI 仍全拒
  for (const v of ['../escape', '..\\escape', 'a/../../../x', 'CON']) {
    const r = run(['assemble', v]);
    check(`CLI 穿越[${v}] exit=2`, r.code === 2, `code=${r.code}`);
  }
  // 7. --yes 位置无关（无信号时 heal 返回 ERR_HEAL_NO_ACTION exit=9，FIX-7）
  const h1 = run(['heal', '--yes', 'example']);
  const h2 = run(['heal', 'example', '--yes']);
  check('CLI --yes 位置无关', h1.code === h2.code && h1.code === 9, `h1=${h1.code} h2=${h2.code}`);
  // 8. --json 可解析（完整 stdout）
  const j = run(['status', 'example', '--json']);
  let jsonOk = false;
  try { const parsed = JSON.parse(j.stdout); jsonOk = parsed.ok === true && parsed.exitCode === 0; } catch (_) {}
  check('CLI --json 可解析', jsonOk, `code=${j.code}`);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n===== CLI 冒烟: ${results.length - failed.length}/${results.length} 通过 =====`);
  fs.rmSync(smoke, { recursive: true, force: true });
  process.exit(failed.length > 0 ? 1 : 0);
})();
