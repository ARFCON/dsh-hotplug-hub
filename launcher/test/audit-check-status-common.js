'use strict';
// test/audit-check-status-common.js — check/status/logs 审计（R4）共享测试工具
// 供 audit-check-status-r4*.test.js 复用（单一真源，避免多文件重复 helper 漂移）。
const fs = require('fs');
const path = require('path');
const { createCore } = require('../app/create-core');
const { isolatedEnv } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const CRASH_LOOP_THRESHOLD = 3;

function emptyState(id, overrides = {}) {
  return {
    schemaVersion: 1, id, assemblySha256: null, phase: 'IDLE',
    resolved: { plugins: [], conflicts: [], pinnedAt: null },
    install: { status: 'missing', lastExit: null, nodeModules: false },
    launch: { lastExit: null, lastStart: null, retries: 0, pid: null },
    heal: { history: [], quarantined: [] },
    rollback: { snapshot: null, lastRollbackAt: null },
    ...overrides
  };
}

function makeCore(home, opts = {}) {
  return createCore({
    baseDir: ROOT,
    home,
    platform: 'win32',
    env: isolatedEnv(home),
    nowPort: opts.nowPort,
    roots: {
      assemblyDir: path.join(home, 'assembly'),
      sandboxRoot: path.join(home, 'sandbox'),
      profilesRoot: path.join(home, '.dsh', 'profiles'),
      storeRoot: path.join(home, '.dsh', 'hotplug-store')
    }
  });
}

/** 写一个无冲突的 assembly（单一 npm 精确版本插件）。 */
function writeCleanAssembly(core, id = 'demo') {
  const dir = path.join(core.config.roots.assemblyDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'assembly.json'), JSON.stringify({
    hotpack: '1.0', id, name: 'clean', version: '1.0.0',
    plugins: [
      { id: 'a', name: 'pkg-a', version: '1.0.0', source: { type: 'npm' }, config: {} }
    ]
  }));
}

/** 写一个依赖图冲突 assembly：pkg-b 依赖 pkg-a@^2.0.0 而实际 1.0.0（error 级）。 */
function writeConflictAssembly(core, id = 'demo') {
  const dir = path.join(core.config.roots.assemblyDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'assembly.json'), JSON.stringify({
    hotpack: '1.0', id, name: 'd', version: '1.0.0',
    plugins: [
      { id: 'a', name: 'pkg-a', version: '1.0.0', source: { type: 'npm' }, config: {} },
      { id: 'b', name: 'pkg-b', version: '1.0.0', source: { type: 'npm' }, config: { dependencies: { 'pkg-a': '^2.0.0' } } }
    ]
  }));
}

/** 写一个角色冲突 assembly：两个不同名插件声明相同 role（error 级）。 */
function writeRoleConflictAssembly(core, id = 'demo') {
  const dir = path.join(core.config.roots.assemblyDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'assembly.json'), JSON.stringify({
    hotpack: '1.0', id, name: 'r', version: '1.0.0',
    plugins: [
      { id: 'a', name: 'pkg-a', version: '1.0.0', source: { type: 'npm' }, config: { role: 'Search' } },
      { id: 'b', name: 'pkg-b', version: '1.0.0', source: { type: 'npm' }, config: { role: 'search' } }
    ]
  }));
}

/** 写一个 warning-only 冲突 assembly：pkg-b 声明非法依赖范围（warning 级，不阻断）。 */
function writeWarningOnlyAssembly(core, id = 'demo') {
  const dir = path.join(core.config.roots.assemblyDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'assembly.json'), JSON.stringify({
    hotpack: '1.0', id, name: 'w', version: '1.0.0',
    plugins: [
      { id: 'a', name: 'pkg-a', version: '1.0.0', source: { type: 'npm' }, config: {} },
      { id: 'b', name: 'pkg-b', version: '1.0.0', source: { type: 'npm' }, config: { dependencies: { 'pkg-a': 'not-a-range' } } }
    ]
  }));
}

/** 只造 sandbox/profile 两件（不碰 assembly，供与 writeCleanAssembly 联用）。 */
function setupStatusFiles(core, id = 'demo') {
  const sandboxDir = path.join(core.config.roots.sandboxRoot, id);
  const profileDir = path.join(core.config.roots.profilesRoot, id);
  fs.mkdirSync(sandboxDir, { recursive: true });
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(sandboxDir, 'package.json'), '{}');
  fs.writeFileSync(path.join(profileDir, 'package.json'), '{}');
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '[]');
}

/** 造三件套完好（assembly/sandbox/profile）的磁盘形态，使 healthy 仅由 state 信号决定。 */
function setupHealthyFiles(core, id = 'demo') {
  const assemblyDir = path.join(core.config.roots.assemblyDir, id);
  const sandboxDir = path.join(core.config.roots.sandboxRoot, id);
  const profileDir = path.join(core.config.roots.profilesRoot, id);
  for (const dir of [assemblyDir, sandboxDir, profileDir]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(assemblyDir, 'assembly.json'), '{}');
  fs.writeFileSync(path.join(sandboxDir, 'package.json'), '{}');
  fs.writeFileSync(path.join(profileDir, 'package.json'), '{}');
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '[]');
}

/** 写 run.jsonl（+ 可选 run.jsonl.1）。 */
function writeLogFile(core, id, mainLines, rotatedLines = []) {
  const logDir = path.join(core.config.roots.sandboxRoot, id, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  if (rotatedLines.length > 0) {
    fs.writeFileSync(path.join(logDir, 'run.jsonl.1'),
      rotatedLines.map((l, i) => JSON.stringify({ seq: i + 1, t: 'x', stream: 'stdout', line: l }) + '\n').join(''), 'utf8');
  }
  const base = rotatedLines.length;
  fs.writeFileSync(path.join(logDir, 'run.jsonl'),
    mainLines.map((l, i) => JSON.stringify({ seq: base + i + 1, t: 'x', stream: 'stdout', line: l }) + '\n').join(''), 'utf8');
}

module.exports = {
  ROOT, CRASH_LOOP_THRESHOLD, emptyState, makeCore,
  writeCleanAssembly, writeConflictAssembly, writeRoleConflictAssembly, writeWarningOnlyAssembly,
  setupStatusFiles, setupHealthyFiles, writeLogFile
};
