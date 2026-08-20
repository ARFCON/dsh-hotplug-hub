#!/usr/bin/env node
// launcher/index.js — DSH-Hotplug-Hub 独立启动器 CLI
// 文本输出风格遵循 开发文档/DSH-统一UI开发标准.md §4.4：
//   状态行 = 大写动词徽标（ASSEMBLE OK / CHECK OK / HEAL OK / LAUNCH OK ...）
//   失败走 console.error；详情子项统一缩进；不引入 ANSI。
// 用法:
//   node launcher/index.js assemble <id>
//   node launcher/index.js check <id>
//   node launcher/index.js launch <id>
//   node launcher/index.js heal <id> [--yes]
//   node launcher/index.js status <id>
'use strict';
const core = require('./core');

function usage() {
  console.log(`DSH-Hotplug-Hub Launcher
用法:
  node launcher/index.js assemble <id>     组装 sandbox profile
  node launcher/index.js check <id>        冲突预检
  node launcher/index.js launch <id>       同步 profile 并拉起 DSH
  node launcher/index.js heal <id> [--yes] 自愈（默认预览）
  node launcher/index.js status <id>       查看状态`);
}

function runAssemble(id) {
  const r = core.assemble(id);
  if (!r.ok) { console.error('ASSEMBLE FAIL:', r.error); process.exit(1); }
  console.log('ASSEMBLE OK');
  console.log('sandbox:', r.sandbox);
  r.steps.forEach((s) => console.log('  -', s.id, s.name));
}

function runCheck(id) {
  const r = core.resolveAssembly(id);
  if (!r.ok) { console.error('CHECK FAIL:', r.error); process.exit(1); }
  const c = r.resolved.conflicts || [];
  console.log(c.length ? 'CONFLICTS:' : 'CHECK OK: no conflicts');
  c.forEach((x) => console.log(`  [${x.type}] ${x.plugin} — ${x.reason} -> ${x.suggest}`));
}

function runLaunch(id) {
  const r = core.launchAndCapture(id);
  if (!r.ok) { console.error('LAUNCH FAIL:', r.error); process.exit(1); }
  console.log('LAUNCH OK pid=' + r.pid);
  console.log('profile:', r.profile);
  console.log('log:', r.logFile);
}

function runHeal(id, yes) {
  const r = core.selfHeal(id, { yes });
  if (!r.ok) { console.error('HEAL FAIL:', r.error); process.exit(1); }
  console.log('HEAL OK');
  console.log(r.note);
  r.healed.forEach((h) => console.log(`  [${h.code}] ${h.suggest}`));
}

function runStatus(id) {
  const fs = require('fs');
  const path = require('path');
  const sandbox = path.join(core.SANDBOX_ROOT, id);
  const assembly = path.join(core.ASSEMBLY_DIR, id, 'assembly.json');
  console.log('id:', id);
  console.log('assembly:', fs.existsSync(assembly) ? 'yes' : 'no');
  console.log('sandbox:', fs.existsSync(sandbox) ? 'yes' : 'no');
  console.log('harness:', core.findOfficialHarness() || 'not found');
}

function main() {
  const [cmd, id, ...rest] = process.argv.slice(2);
  const yes = rest.includes('--yes');
  if (!cmd || !id) { usage(); process.exit(1); }
  switch (cmd) {
    case 'assemble': runAssemble(id); break;
    case 'check': runCheck(id); break;
    case 'launch': runLaunch(id); break;
    case 'heal': runHeal(id, yes); break;
    case 'status': runStatus(id); break;
    default: usage(); process.exit(1);
  }
}

main();