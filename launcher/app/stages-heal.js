'use strict';
// app/stages-heal.js — heal 阶段实现 + 自愈上下文（与主写阶段分离，保持 ≤300 行）
const path = require('path');
const { STATES, assertCommandPipeline } = require('../contracts/state-machine');
const { makeError } = require('../contracts/errors');
const { okResult, errResult, runLogFileFor, quarantinedNames } = require('./stages-util');

// --- heal：分类 → 计划 → 执行 + 验证 + 回滚 + 预算 ---
async function stageHeal(core, state, args) {
  const { id, yes } = args;
  const fsPort = core.ports.fs;
  const t = assertCommandPipeline(state.phase || STATES.IDLE, 'heal');
  if (!t.ok) return errResult(t.error);
  const runLog = core.infra.runlog.createRunLog(fsPort, runLogFileFor(core, id), { now: core.ports.now.now });
  // C3 修复（幻影自愈）：只分类最近一次启动（state.launch.lastStart）之后的日志行，
  // 陈旧故障行不再触发自愈动作（手册 P3 观察项落地）。
  const since = state.launch && state.launch.lastStart ? Date.parse(state.launch.lastStart) : 0;
  const recentEntries = (Number.isNaN(since) ? runLog.list() : runLog.list().filter((e) => {
    const et = e.t ? Date.parse(e.t) : NaN;
    return Number.isNaN(et) || et >= since;
  }));
  const classifications = core.domain.classify.classifyEntries(recentEntries)
    // C3 修复（CRASH_LOOP 可达性）：合并状态驱动信号——进程退出码不进 run.jsonl，
    // 仅靠日志永远无法触发 CRASH_LOOP；state.launch 的退出信息现在被纳入分类。
    .concat(core.domain.classify.classifyStateSignals(state));
  const planned = core.domain.healplan.planActions(classifications, { dryRun: !yes });
  if (planned.actions.length === 0) {
    // FIX-7：无结构化信号 → ERR_HEAL_NO_ACTION（exit 9），不再静默 HEAL OK（P 缺陷修复）
    return errResult(makeError('ERR_HEAL_NO_ACTION', '无自愈信号，无需动作（检查 run.jsonl 是否有故障日志）'));
  }
  const profileDir = path.join(core.config.roots.profilesRoot, id);
  // C7 修复：heal 执行前确保 profile 目录存在（此前从未 launch 的 id 直接 heal 时，
  // reinstall 的 npm install 以缺失目录为 cwd → 误导性的 ENOENT/ERR_INSTALL_FAILED）
  try {
    fsPort.mkdirSync(profileDir, { recursive: true });
  } catch (e) {
    return errResult(makeError('ERR_INSTALL_DEP', `无法创建 profile 目录 ${profileDir}：${e.message}`));
  }
  const ctx = buildHealContext(core, state, id, profileDir);
  const run = await core.infra.heal.runHeal(core, planned.actions, ctx, { dryRun: !yes });
  if (!run.ok) {
    // C7 修复：预览（无 --yes）零持久副作用——不写 phase/history/dirty；
    // 执行模式（--yes）才持久化（含失败路径的 history 与 QUARANTINED）。
    if (yes) {
      state.heal.history = (state.heal.history || []).concat(run.result.history);
      state.phase = STATES.QUARANTINED;
      state.dirty = true;
    }
    return errResult(run.error);
  }
  if (yes) {
    state.heal.history = (state.heal.history || []).concat(run.result.history);
    state.phase = STATES.HEALING;
    state.dirty = true;
  }
  return okResult(yes ? 'HEAL OK：已执行自愈动作' : 'HEAL OK：预览（加 --yes 执行）', {
    id, history: run.result.history, actions: planned.actions.map((a) => a.code)
  });
}

// FIX-16/17：heal 上下文（quarantine 写 quarantined；onMirror 镜像重试）
// C3 修复：quarantine 支持指定目标插件（disable-recent 需要禁用"最近变更插件"，
// 而非无差别隔离最后一个）。
function buildHealContext(core, state, id, profileDir) {
  // C6 修复：heal 上下文只含未被隔离的插件——INSTALL_FAIL 重装/LINK_FAIL 重建等
  // 动作不得把已隔离插件装回来（quarantine 消费一致性）。
  const qset = new Set(quarantinedNames(state));
  const plugins = ((state.resolved && state.resolved.plugins) || []).filter((p) => !qset.has(p.name));
  return {
    state, profile: profileDir, plugins, pack: { id, plugins },
    quarantine: (targetName) => {
      const target = targetName || (plugins.length > 0 ? plugins[plugins.length - 1].name : null);
      if (!target) return { ok: false, error: makeError('ERR_HEAL_BUDGET', '无插件可隔离') };
      const q = new Set(state.heal.quarantined || []);
      q.add(target);
      state.heal.quarantined = [...q];
      state.dirty = true;
      return { ok: true };
    },
    onMirror: async (mirror) => {
      const gh = plugins.find((p) => p.source && p.source.type === 'github');
      if (!gh) return { ok: false, error: makeError('ERR_INSTALL_ACQUIRE', '无 github 源插件可重试') };
      return core.infra.install.installGithubPluginWithMirror(core, gh, profileDir, mirror);
    }
  };
}

module.exports = { stageHeal, buildHealContext };
