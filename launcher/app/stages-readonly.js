'use strict';
// app/stages-readonly.js — 只读阶段（check/status/logs）：零副作用契约
// F 修复：check 不再写 resolvedAssembly.json；status/logs 亦零写盘。
const path = require('path');
const { STATES } = require('../contracts/state-machine');
const { makeError } = require('../contracts/errors');
const { PATCH_FILE, PROFILE_MANIFEST, CRASH_LOOP_THRESHOLD } = require('../contracts/constants');
const { okResult, errResult, runLogFileFor, quarantinedNames } = require('./stages-util');

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
  // 审计修复（check↔assemble 判定漂移）：隔离名单与 assemble 同一过滤——heal 把冲突插件
  // 写入 quarantined 后，assemble/install/launch 都按剔除后的清单判定，唯独 check 仍用
  // 全量 → 自愈后复检闸门永远红灯（ERR_CONFLICT_*）。同一 quarantinedNames 单一真源。
  const qset = new Set(quarantinedNames(state));
  const filtered = qset.size > 0
    ? { ...parsed.pack, plugins: parsed.pack.plugins.filter((p) => !qset.has(p.name)) }
    : parsed.pack;
  const resolved = core.domain.resolve.resolvePlugins(filtered, core.ports.registry);
  if (!resolved.ok) return errResult(resolved.error);
  const conflictCheck = core.domain.conflicts.checkConflicts(resolved.resolved.plugins);
  const blocking = conflictCheck.conflicts.filter((c) => c.severity === 'error');
  if (blocking.length > 0) {
    return errResult(makeError(blocking[0].code, `${blocking.length} 个冲突：${blocking.map((c) => c.reason).join('；')}`));
  }
  // stateDegraded：state.json 损坏降级时隔离名单不可读——heal 隔离过的插件可能重新被
  // 点名（复检闸门在「heal 后 + state 损坏」场景会偏严），显式提示消费方而非静默。
  return okResult('CHECK OK：无阻断冲突', { id, conflicts: conflictCheck.conflicts, warnings: resolved.warnings || [], stateDegraded: state._corrupted === true });
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
  // 审计修复（healthy 漏报）：此前 healthy 只看三个文件存在性——install 失败、活跃崩溃
  // 循环、隔离名单非空、QUARANTINED 相位都不影响判定，可产出「phase=QUARANTINED +
  // STATUS OK」的自相矛盾输出（监控/运维方被误导）。这些信号是状态机自己的产物，
  // 磁盘三件套完好不等于健康。
  const installFailed = !!(state.install && state.install.status === 'failed');
  const quarantinedCount = quarantinedNames(state).length;
  // 崩溃循环：监控期（MONITORING）连续失败计数达到阈值（成功即清零，见 classify）
  const crashLooping = typeof (state.launch && state.launch.retries) === 'number'
    && state.launch.retries >= CRASH_LOOP_THRESHOLD
    && state.phase === STATES.MONITORING;
  const phaseQuarantined = state.phase === STATES.QUARANTINED;
  const stateOk = state._corrupted !== true;
  const healthy = assemblyExists && sandboxExists && profileOk
    && !installFailed && quarantinedCount === 0 && !crashLooping && !phaseQuarantined && stateOk;
  return okResult(healthy ? 'STATUS OK' : 'STATUS DEGRADED', {
    id,
    phase: state.phase || STATES.IDLE,
    healthy,
    stateOk,
    assemblyExists,
    sandboxExists,
    profileOk,
    installOk: !installFailed,
    quarantinedCount,
    crashLooping,
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
