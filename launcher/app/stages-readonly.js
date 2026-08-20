'use strict';
// app/stages-readonly.js — 只读阶段（check/status/logs）：零副作用契约
// F 修复：check 不再写 resolvedAssembly.json；status/logs 亦零写盘。
const path = require('path');
const { STATES } = require('../contracts/state-machine');
const { makeError } = require('../contracts/errors');
const { PATCH_FILE, PROFILE_MANIFEST } = require('../contracts/constants');
const { okResult, errResult, runLogFileFor } = require('./stages-util');

// --- check：只读冲突预检（F 修复：零副作用）---
async function stageCheck(core, state, args) {
  const { id } = args;
  const fsPort = core.ports.fs;
  const roots = core.config.roots;
  const assemblyFile = path.join(roots.assemblyDir, id, 'assembly.json');
  if (!fsPort.existsSync(assemblyFile)) {
    return errResult(makeError('ERR_ASSEMBLY_NOT_FOUND', `找不到 assembly：${assemblyFile}`));
  }
  let raw;
  try {
    raw = fsPort.readFileSync(assemblyFile, 'utf8');
  } catch (e) {
    // FIX-22：读取失败（权限等）转语义错误码，不抛 FATAL
    return errResult(makeError('ERR_ASSEMBLY_NOT_FOUND', `读取 assembly 失败：${e.message}`));
  }
  const parsed = core.domain.assembly.parseHotpack(raw);
  if (!parsed.ok) return errResult(parsed.error);
  const resolved = core.domain.resolve.resolvePlugins(parsed.pack, core.ports.registry);
  if (!resolved.ok) return errResult(resolved.error);
  const conflictCheck = core.domain.conflicts.checkConflicts(resolved.resolved.plugins);
  const blocking = conflictCheck.conflicts.filter((c) => c.severity === 'error');
  if (blocking.length > 0) {
    return errResult(makeError(blocking[0].code, `${blocking.length} 个冲突：${blocking.map((c) => c.reason).join('；')}`));
  }
  return okResult('CHECK OK：无阻断冲突', { id, conflicts: conflictCheck.conflicts, warnings: resolved.warnings || [] });
}

// --- status：只读健康报告（N40/N45 修复 + A2 强化：零子进程、诚实降级）---
async function stageStatus(core, state, args) {
  const { id } = args;
  const fsPort = core.ports.fs;
  const roots = core.config.roots;
  const assemblyExists = fsPort.existsSync(path.join(roots.assemblyDir, id, 'assembly.json'));
  const sandboxExists = fsPort.existsSync(path.join(roots.sandboxRoot, id, PROFILE_MANIFEST));
  // A2 修复：status 是只读命令，findHarness 不得 spawn 探测 PATH（probe:false），
  // 只检查候选路径；不产生任何子进程副作用。
  const harness = core.infra.harness.findHarness(core, { probe: false });
  const profileDir = path.join(roots.profilesRoot, id);
  const profileOk = fsPort.existsSync(path.join(profileDir, PROFILE_MANIFEST)) &&
    fsPort.existsSync(path.join(profileDir, PATCH_FILE));
  const healthy = assemblyExists && sandboxExists && profileOk;
  return okResult(healthy ? 'STATUS OK' : 'STATUS DEGRADED', {
    id,
    phase: state.phase || STATES.IDLE,
    healthy,
    assemblyExists,
    sandboxExists,
    profileOk,
    harness: harness.ok ? harness.harness : null,
    harnessError: harness.ok ? null : harness.error.message,
    install: state.install,
    launch: state.launch,
    heal: { historyCount: (state.heal.history || []).length, quarantined: state.heal.quarantined || [] }
  });
}

// --- logs：只读日志（tail；C4 修复：合并滚动文件 .1，滚动前条目可读）---
async function stageLogs(core, state, args) {
  const { id, tail } = args;
  const fsPort = core.ports.fs;
  const runLog = core.infra.runlog.createRunLog(fsPort, runLogFileFor(core, id), { now: core.ports.now.now });
  const entries = runLog.list({ includeRotated: true });
  const sliced = tail > 0 ? entries.slice(-tail) : entries;
  return okResult('LOGS OK', { id, count: entries.length, entries: sliced });
}

module.exports = { stageCheck, stageStatus, stageLogs };
