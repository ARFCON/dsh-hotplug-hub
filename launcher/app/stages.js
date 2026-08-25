'use strict';
// app/stages.js — 写流水线阶段（assemble/install/launch/rollback）+ STAGES 注册表
// 只读阶段（check/status/logs）见 stages-readonly.js；heal 见 stages-heal.js；
// 共享 helper 见 stages-util.js（模块拆分保证每个源文件 ≤300 行，DoD-16）。
const path = require('path');
const { STATES, assertCommandPipeline } = require('../contracts/state-machine');
const { makeError } = require('../contracts/errors');
const { PATCH_FILE, PROFILE_MANIFEST } = require('../contracts/constants');
const { buildManifest } = require('../domain/manifest');
const {
  okResult, errResult, sandboxDir, stateFilePathFor, runLogFileFor, quarantinedNames
} = require('./stages-util');
const { stageCheck, stageStatus, stageLogs } = require('./stages-readonly');
const { stageHeal, buildHealContext } = require('./stages-heal');
const { UTF8_CORRUPTION_MARKER } = require('../domain/classify');

// --- assemble：组装 + 校验 + 解析 + 冲突 + 生成 sandbox 产物 ---
async function stageAssemble(core, state, args) {
  const { id } = args;
  const fsPort = core.ports.fs;
  const roots = core.config.roots;
  const t = assertCommandPipeline(state.phase || STATES.IDLE, 'assemble');
  if (!t.ok) return errResult(t.error);

  const assemblyFile = path.join(roots.assemblyDir, id, 'assembly.json');
  const within = core.domain.ids.assertWithin(roots.assemblyDir, assemblyFile, 'assembly 文件');
  if (!within.ok) return errResult(within.error);
  if (!fsPort.existsSync(assemblyFile)) {
    return errResult(makeError('ERR_ASSEMBLY_NOT_FOUND', `找不到 assembly：${assemblyFile}`));
  }
  let raw;
  try {
    raw = fsPort.readFileSync(assemblyFile, 'utf8');
  } catch (e) {
    return errResult(makeError('ERR_ASSEMBLY_NOT_FOUND', `读取 assembly 失败：${e.message}`));
  }
  const parsed = core.domain.assembly.parseHotpack(raw);
  if (!parsed.ok) return errResult(parsed.error);

  // C6 修复（quarantine 消费）：被隔离插件不进入任何产物——
  // resolved/patch/manifest/steps 全部排除，隔离在重新组装时真正生效。
  const qset = new Set(quarantinedNames(state));
  const excluded = parsed.pack.plugins.filter((p) => qset.has(p.name)).map((p) => p.name);
  const pack = excluded.length > 0
    ? { ...parsed.pack, plugins: parsed.pack.plugins.filter((p) => !qset.has(p.name)) }
    : parsed.pack;

  const sha = core.infra.store.computeFileSha256(fsPort, assemblyFile);
  const resolved = core.domain.resolve.resolvePlugins(pack, core.ports.registry);
  if (!resolved.ok) return errResult(resolved.error);
  resolved.resolved.pinnedAt = core.ports.now.iso();

  const conflictCheck = core.domain.conflicts.checkConflicts(resolved.resolved.plugins);
  const blocked = core.domain.conflicts.assertNoBlockingConflicts(conflictCheck.conflicts);
  if (!blocked.ok) return errResult(blocked.error);

  const patch = core.domain.patch.serializePatch(pack);
  if (!patch.ok) return errResult(patch.error);

  const sbDir = sandboxDir(core, id);
  // N37：清理残留（越界防护 root=sandboxRoot）
  const cleaned = core.infra.snapshot.cleanupResidue(fsPort, sbDir, {
    root: roots.sandboxRoot,
    keep: [PROFILE_MANIFEST, PATCH_FILE],
    keepPrefix: ['logs']
  });
  if (!cleaned.ok) return errResult(cleaned.error);

  const manifest = buildManifest(pack, resolved.resolved.plugins, roots.storeRoot);
  const w1 = core.infra.atomic.writeFileAtomic(fsPort, path.join(sbDir, PROFILE_MANIFEST), JSON.stringify(manifest, null, 2) + '\n');
  if (!w1.ok) return errResult(w1.error);
  const w2 = core.infra.atomic.writeFileAtomic(fsPort, path.join(sbDir, PATCH_FILE), patch.yamlText);
  if (!w2.ok) return errResult(w2.error);
  try {
    fsPort.mkdirSync(path.join(sbDir, 'logs'), { recursive: true });
  } catch (e) {
    // C1 修复：写路径不再裸抛（此前 mkdirSync 异常穿透到 index.js FATAL exit 1，
    // 破坏"所有失败走 ERR_ 码"契约）
    return errResult(makeError('ERR_INSTALL_FAILED', `创建 sandbox logs 目录失败：${e.message}`));
  }

  state.assemblySha256 = sha;
  state.resolved = resolved.resolved;
  state.resolved.conflicts = conflictCheck.conflicts;
  // M-23 修复（v5 阶段 2）：reassemble 重置过期子状态——新装配的 install/launch/
  // rollback 快照全部失效，残留的 retries/history 快照会误导后续阶段
  // （heal 计数、rollback 恢复错误内容）；隔离列表（quarantined）保留（隔离跨重建生效）。
  state.install = { status: 'missing', lastExit: null, nodeModules: false };
  state.launch = { lastExit: null, lastStart: null, retries: 0, pid: null };
  state.rollback = { snapshot: null, lastRollbackAt: null };
  state.phase = STATES.CHECKED;
  state.dirty = true;
  return okResult(`组装完成（id=${id}，sha256=${sha.slice(0, 12)}…）`, {
    id, sha256: sha, sandbox: sbDir,
    steps: pack.plugins.map((p) => ({ id: p.id, name: p.name })),
    warnings: resolved.warnings || [],
    cleaned: cleaned.removed,
    excluded
  });
}

// --- install：真正安装（B 修复）---
async function stageInstall(core, state, args) {
  const { id } = args;
  const t = assertCommandPipeline(state.phase || STATES.IDLE, 'install');
  if (!t.ok) return errResult(t.error);
  if (!state.resolved || !Array.isArray(state.resolved.plugins)) {
    return errResult(makeError('ERR_INSTALL_DEP', '缺少 resolved 结果，请先 assemble'));
  }
  // C6 修复：被隔离插件不安装（与 assemble/launch 的排除语义一致）
  const qset = new Set(quarantinedNames(state));
  const targets = state.resolved.plugins.filter((p) => !qset.has(p.name));
  const excluded = state.resolved.plugins.filter((p) => qset.has(p.name)).map((p) => p.name);
  const sbDir = sandboxDir(core, id);
  const r = await core.infra.install.installPlugins(core, targets, { profile: sbDir });
  if (!r.ok) {
    // C1 修复：install 失败路径持久化 status='failed'（schema 枚举含 failed 但
    // 此前无代码写入；与 FIX-4 launch 失败持久化对齐）。
    // C6 修复：lastExit 存真实子进程退出码（childExitCode），与 launch 语义一致。
    // 审计修复：无 childExitCode（spawn 失败/未启动）时记 null 而非回退 r.error.exitCode
    // （ERR_* 契约退出码）——后者会把契约码 6 混入「子进程真实退出码」语义，与
    // stageLaunch「无 childExitCode 记 null」口径一致。
    state.install = {
      status: 'failed',
      lastExit: r.error.childExitCode !== undefined ? r.error.childExitCode : null,
      nodeModules: false
    };
    state.dirty = true;
    return errResult(r.error);
  }
  state.install = { status: 'ok', lastExit: 0, nodeModules: r.result.nodeModules };
  state.phase = STATES.INSTALLED;
  state.dirty = true;
  return okResult('INSTALL OK', { id, ...r.result, excluded });
}

// --- launch：同步（先校验 harness）+ 启动 + 监控 ---
async function stageLaunch(core, state, args) {
  const { id, wait, timeoutMs } = args;
  const fsPort = core.ports.fs;
  const roots = core.config.roots;

  // 状态守卫 + harness 前置校验（H 修复：先校验后副作用）
  const t = assertCommandPipeline(state.phase || STATES.IDLE, 'launch');
  if (!t.ok) return errResult(t.error);
  const harness = core.infra.harness.findHarness(core);
  if (!harness.ok) return errResult(harness.error);

  const sync = core.infra.profile.syncProfile(core, id, { requireHarness: false, exclude: quarantinedNames(state) });
  if (!sync.ok) return errResult(sync.error);

  const logFile = runLogFileFor(core, id);
  const runLog = core.infra.runlog.createRunLog(fsPort, logFile, { now: core.ports.now.now });
  const profileDir = sync.result.profile;
  const env = { DSH_PROFILE: id };
  const argsList = core.config.platform !== 'win32' ? ['--profile', id] : [];
  // FIX-2：rollback 快照 = 同步前快照（回滚即恢复 launch 前内容）。
  // C6 修复：只更新 snapshot 字段，lastRollbackAt 保持最近一次"实际回滚"的时间
  //（launch 不是回滚，不得改写该字段）。
  const snap = sync.result.snapshot;
  state.rollback = { ...(state.rollback || {}), snapshot: snap || null };
  state.dirty = true;

  // H3b 修复：lastStart 记录「本次 launch 开始」——失败 launch（崩溃/spawn 失败）也须
  // 锚定本次启动；否则下方 !launched.ok 分支不写 lastStart，heal 的 fail-closed 过滤
  // （lastStart 缺失 → 不分类日志）会把本次崩溃写进 run.jsonl 的 stderr 一并排除，
  // DoD-3「崩溃 → heal 闭环」退化为 exit=9 无信号。
  const launchStartIso = core.ports.now.iso();
  state.launch.lastStart = launchStartIso;

  // UTF-8 字节级拼接 + 按行 JSONL（M/N36）
  const decoders = {
    stdout: core.infra.monitor.createLineDecoder(),
    stderr: core.infra.monitor.createLineDecoder()
  };
  const logWarnings = [];
  const logAppend = (stream, line) => {
    const r = runLog.append({ stream, line });
    if (!r.ok && logWarnings.length < 3) logWarnings.push(r.error.message); // FIX-24
  };
  // C6 修复：子进程真正退出时冲刷解码器尾部——run.jsonl 不再丢失
  // 无换行符的最后一行；残缺多字节按 UTF8_CORRUPTION 信号写入 error 流
  // （此前 stageLaunch 只 push 不 flush，尾行静默丢弃）。
  const flushDecoder = (streamName) => {
    const decoder = decoders[streamName];
    if (!decoder) return;
    for (const line of decoder.flush()) {
      if (line && line.__corrupt) {
        // 携带机器标记，classify 据此识别为 UTF8_CORRUPTION 自愈动作（契约统一）
        logAppend('error', `${UTF8_CORRUPTION_MARKER} 检测到 UTF-8 损坏（流结束时残缺多字节序列，stream=${streamName}）`);
      } else {
        logAppend(streamName, line);
      }
    }
  };
  const launched = await core.infra.launch.launchProcess(core, {
    harness: harness.harness,
    profile: profileDir,
    args: argsList,
    env,
    wait: Boolean(wait),
    timeoutMs,
    onStdout: (d) => { for (const line of decoders.stdout.push(d)) logAppend('stdout', line); },
    onStderr: (d) => { for (const line of decoders.stderr.push(d)) logAppend('stderr', line); },
    onExit: () => { flushDecoder('stdout'); flushDecoder('stderr'); }
  });
  if (!launched.ok) {
    // C1 修复：lastExit 记录子进程真实退出码（childExitCode），而非 ERR_ 契约码——
    // 此前 ERR_LAUNCH_EXIT 的契约码 8 被存入 lastExit，真实退出码丢失，
    // 导致 CRASH_LOOP 验证读到错误语义（8 与真实退出 8 无法区分）。
    // C6 修复：失败时 pid 置 null（无存活进程），避免残留旧 pid 误导 status。
    state.launch = {
      ...state.launch,
      // 审计修复：无 childExitCode（spawn/timeout/detach 等基础设施失败，子进程从未
      // 启动/退出）时 lastExit 记 null，而非 fallback 到 ERR_ 契约码 8——后者会让
      // classifyStateSignals 误判为"非零退出→CRASH_LOOP"（基础设施失败应走 HARNESS_FIX）。
      // null 与"detach 存活中 lastExit:null"语义一致，classifyStateSignals 视为无信号。
      lastExit: launched.error.childExitCode !== undefined ? launched.error.childExitCode : null,
      // 自愈审计修复：spawn 失败持久化底层错误码（ENOENT/EACCES/EPERM/UNKNOWN），
      // 供 classifyStateSignals 复用 spawn-error 分支 → HARNESS_FIX/INSTALL_FAIL 可达。
      // 成功启动时 state.launch 重建会自然清除该字段。
      spawnCode: launched.error.code === 'ERR_LAUNCH_SPAWN' ? (launched.error.cause && launched.error.cause.code) || null : null,
      retries: (state.launch.retries || 0) + 1,
      pid: null
    };
    state.dirty = true; // FIX-4：失败路径也持久化（retries 计数不得丢失）
    return errResult(launched.error);
  }
  state.launch = {
    lastExit: launched.result.exitCode === undefined ? null : launched.result.exitCode,
    lastStart: launchStartIso, // H3b：保留 launch 开始时刻（成功也不重写为结束时刻）
    // C6 修复：成功启动即清零 retries——崩溃循环判定采用"连续失败"语义，
    // 否则任意历史失败累计到 3 次后一次成功也无法解除 CRASH_LOOP 触发。
    retries: 0,
    pid: launched.result.pid
  };
  state.phase = launched.result.mode === 'wait' ? STATES.LAUNCHED : STATES.MONITORING;
  return okResult(
    launched.result.mode === 'wait' ? `LAUNCH OK：退出码 ${launched.result.exitCode}` : `LAUNCH OK pid=${launched.result.pid}`,
    { id, pid: launched.result.pid, mode: launched.result.mode, profile: profileDir, logFile, harness: harness.harness, logWarnings }
  );
}

// --- rollback：回滚到快照 ---
async function stageRollback(core, state, args) {
  const { id } = args;
  const fsPort = core.ports.fs;
  const t = assertCommandPipeline(state.phase || STATES.IDLE, 'rollback');
  if (!t.ok) return errResult(t.error);
  const snap = state.rollback && state.rollback.snapshot;
  if (!snap) {
    return errResult(makeError('ERR_HEAL_ROLLBACK', '无可用快照，无法回滚'));
  }
  const profileDir = path.join(core.config.roots.profilesRoot, id);
  // B1 修复：回滚目标做根域 realpath 越界校验（与 syncProfile 的 assertWithinRealpath
  // 口径一致）——防 profilesRoot/<id> 被预置为 junction/symlink 时回滚逃出根域删文件。
  const r = core.infra.snapshot.restoreSnapshot(fsPort, snap, profileDir, { root: core.config.roots.profilesRoot });
  if (!r.ok) return errResult(r.error);
  state.phase = STATES.ROLLED_BACK;
  state.rollback.lastRollbackAt = core.ports.now.iso();
  state.dirty = true;
  return okResult('ROLLBACK OK', { id, backupDir: r.backupDir });
}

// 8 阶段注册表：写阶段本文件；只读阶段/自愈分别来自 stages-readonly / stages-heal
const STAGES = {
  assemble: stageAssemble,
  check: stageCheck,
  install: stageInstall,
  launch: stageLaunch,
  heal: stageHeal,
  status: stageStatus,
  rollback: stageRollback,
  logs: stageLogs
};

module.exports = {
  STAGES, okResult, errResult, sandboxDir, stateFilePathFor, runLogFileFor, buildHealContext, quarantinedNames
};
