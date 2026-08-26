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
  // H3 修复：lastStart 缺失/不可解析时不存在「最近一次启动之后」的窗口 → 不分类任何
  // 日志行（只保留 classifyStateSignals 的权威 state.launch 信号，如 reassemble 后
  // lastStart=null 的历史故障行不得重新触发）；无有效时间戳的行无法证明「在最近启动
  // 之后」，同样 fail-closed 排除（此前 Number.isNaN(et) 恒通过 → 幻影自愈）。
  const since = state.launch && state.launch.lastStart ? Date.parse(state.launch.lastStart) : NaN;
  const entries = runLog.list();
  const recentEntries = Number.isNaN(since)
    ? []
    : entries.filter((e) => {
        const et = e.t ? Date.parse(e.t) : NaN;
        return !Number.isNaN(et) && et >= since;
      });
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
  // 审计根因修正（heal 安装族目标）：install/reinstall/rebuild-link/onMirror 的落地目标
  // 是【sandbox】（持久源）而非 profile——stageInstall 装进 sandbox，随后 syncProfile
  // 把 sandbox → profile 再建 junction。heal 若把插件直接装进 profile，下一次 launch 的
  // syncProfile 会重新链接 profile/node_modules → sandbox（仍是坏的），heal 的修复被
  // 无声丢弃（假自愈）。故 heal 上下文同时携带 profile（部署产物：package.json/patch/
  // 回滚目标）与 sandbox（安装族落地目标）。
  // 审计根因修正（m7 越界防护）：heal 向 sandboxRoot/<id> 直写（npm/git/link），与
  // syncProfile 对 sandbox 的 realpath 越界校验同一真源——预置 junction 于 sandboxRoot/<id>
  // 会把 heal 的写副作用重定向到根域外，须先 realpath 比真根再落盘。
  let sandboxDirForHeal;
  if (core.config.roots && core.config.roots.sandboxRoot) {
    const sandboxLexical = path.join(core.config.roots.sandboxRoot, id);
    const sandboxCheck = core.domain.ids.assertWithinRealpath(fsPort, core.config.roots.sandboxRoot, sandboxLexical, `sandbox(id=${id})`);
    if (!sandboxCheck.ok) return errResult(sandboxCheck.error);
    sandboxDirForHeal = sandboxCheck.resolvedPath;
  }
  // C7 修复：heal 执行前确保 profile 目录存在（此前从未 launch 的 id 直接 heal 时，
  // reinstall 的 npm install 以缺失目录为 cwd → 误导性的 ENOENT/ERR_INSTALL_FAILED）。
  // 审计修复：mkdirSync 是持久副作用，必须只在执行模式（--yes）下做——预览（无 --yes）
  // 契约承诺"零持久副作用"，此前无条件 mkdirSync 违反该契约。
  if (yes) {
    try {
      fsPort.mkdirSync(profileDir, { recursive: true });
      if (sandboxDirForHeal) fsPort.mkdirSync(sandboxDirForHeal, { recursive: true });
    } catch (e) {
      return errResult(makeError('ERR_INSTALL_DEP', `无法创建 profile/sandbox 目录：${e.message}`));
    }
  }
  const ctx = buildHealContext(core, state, id, profileDir, sandboxDirForHeal);
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
// C3 修复：quarantine 支持指定目标插件（disable-recent 显式传入"解析序末位"插件，
// 而非依赖 quarantine 的缺省末位逻辑——两者目标一致但路径显式、可测试）。
// 审计根因修正：ctx 同时携带 profile（部署产物/回滚目标）与 sandbox（安装族落地目标）——
// install/reinstall/rebuild-link/onMirror 必须装进 sandbox（持久源），否则下一次 launch
// 的 syncProfile 会重新链接 profile/node_modules → sandbox 把 heal 修复丢弃。
function buildHealContext(core, state, id, profileDir, sandboxDirForHeal) {
  // C6 修复：heal 上下文只含未被隔离的插件——INSTALL_FAIL 重装/LINK_FAIL 重建等
  // 动作不得把已隔离插件装回来（quarantine 消费一致性）。
  const qset = new Set(quarantinedNames(state));
  const plugins = ((state.resolved && state.resolved.plugins) || []).filter((p) => !qset.has(p.name));
  return {
    state, profile: profileDir, sandbox: sandboxDirForHeal, plugins, pack: { id, plugins },
    // B1 修复：heal 回滚（rollback-snapshot 步骤 / rollbackAction）复用此根做 realpath
    // 越界校验，与 stageRollback/syncProfile 同一真源——防 profilesRoot/<id> 被预置
    // junction/symlink 时回滚逃出根域。测试最小 core 可能无 config.roots，缺省 undefined
    //（restoreSnapshot 无 root 时不触发越界校验，行为与修复前一致）。
    profileRoot: core.config && core.config.roots ? core.config.roots.profilesRoot : undefined,
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
      // GITHUB_ACQUIRE_FAIL：重试所有"未落地"的 github 源插件（此前只克隆首个 github
      // 插件，非首个失败时 verify 恒失败 → 假自愈）。已落地的跳过（幂等且省流量）。
      const githubs = plugins.filter((p) => p.source && p.source.type === 'github');
      if (githubs.length === 0) return { ok: false, error: makeError('ERR_INSTALL_ACQUIRE', '无 github 源插件可重试') };
      const fsPort = core.ports.fs;
      // 安装族落地目标 = sandbox（持久源，与 install 阶段一致）
      const targetDir = sandboxDirForHeal || profileDir;
      const missing = githubs.filter((p) => !fsPort.existsSync(path.join(targetDir, 'node_modules', p.name, 'package.json')));
      if (missing.length === 0) return { ok: true };
      let lastErr = null;
      for (const gh of missing) {
        const r = await core.infra.install.installGithubPluginWithMirror(core, gh, targetDir, mirror);
        if (!r.ok) { lastErr = r.error; break; }
      }
      return lastErr ? { ok: false, error: lastErr } : { ok: true };
    }
  };
}

module.exports = { stageHeal, buildHealContext };
