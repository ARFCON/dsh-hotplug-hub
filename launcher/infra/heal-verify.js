'use strict';
// infra/heal-verify.js — 自愈动作的效果验证与回滚（与步骤执行分离，模块 ≤300 行）
// 执行见 infra/heal-steps.js；预算编排见 infra/heal.js。
const { makeError } = require('../contracts/errors');

/**
 * 验证动作效果（C3 修复：BUNDLE_MISCLASSIFY/GITHUB_ACQUIRE_FAIL/
 * REGISTRY_UNAVAILABLE/HARNESS_FIX 此前落到默认 {ok:true} 恒通过，
 * 违反"执行 + 验证 + 回滚"契约——现全部有真实验证）。
 * @param {object} core
 * @param {object} action
 * @param {object} ctx
 * @returns {Promise<{ok: boolean, error?: Error}>}
 */
async function verifyAction(core, action, ctx) {
  try {
    // A2 修复：await 核心实现——REGISTRY_UNAVAILABLE 验证须 await 异步 registry 端口，
    // 其 Promise 拒绝须被捕获归一为 {ok:false}，不得成为未处理拒绝穿透 runHeal。
    return await verifyActionUnchecked(core, action, ctx);
  } catch (e) {
    // H6 修复：findHarness 等注入侧抛错统一归一为 {ok:false}，不裸抛穿透 runHeal。
    return { ok: false, error: makeError('ERR_HEAL_BUDGET', `自愈验证异常：${e && e.message ? e.message : e}`) };
  }
}

/** verifyAction 的核心实现（异常由 verifyAction 统一捕获归一为 {ok:false}）。 */
async function verifyActionUnchecked(core, action, ctx) {
  switch (action.code) {
    case 'INSTALL_FAIL': {
      const { verifyInstall } = require('./install');
      const v = verifyInstall(core, ctx.plugins || [], ctx.profile);
      return v.ok ? { ok: true } : { ok: false, error: makeError('ERR_INSTALL_DEP', `安装验证失败，缺失：${v.missing.join(', ')}`) };
    }
    case 'LINK_FAIL': {
      const fsPort = core.ports.fs;
      const path = require('path');
      for (const p of ctx.plugins || []) {
        if (p.source.type !== 'path') continue;
        if (!fsPort.existsSync(path.join(ctx.profile, 'node_modules', p.name))) {
          return { ok: false, error: makeError('ERR_INSTALL_DEP', `link 验证失败：${p.name}`) };
        }
      }
      return { ok: true };
    }
    case 'CRASH_LOOP':
      // C3 修复：detach 成功（lastExit===null，进程存活中）应视为通过——
      // 此前 null!==0 被误判为"持续崩溃"，健康启动在 CRASH_LOOP 验证下恒失败。
      // C6 修复：executeAction 成功应用补救步骤后已把 lastExit/retries 重置，
      // 此处读到 null → 通过（闭环）。
      {
        const s = ctx.state || {};
        const lastExit = s.launch && s.launch.lastExit;
        if (lastExit === null || lastExit === undefined || lastExit === 0) return { ok: true };
        return {
          ok: false,
          error: makeError('ERR_HEAL_BUDGET', `CRASH_LOOP 验证失败：最近退出码 ${lastExit}（非 0），retries=${(s.launch && s.launch.retries) || 0}`)
        };
      }
    case 'UTF8_CORRUPTION': {
      const fsPort = core.ports.fs;
      const path = require('path');
      const patchFile = path.join(ctx.profile, 'cordis.patch.yml');
      if (fsPort.existsSync(patchFile) && fsPort.readFileSync(patchFile, 'utf8').includes('\uFFFD')) {
        return { ok: false, error: makeError('ERR_YAML_PARSE', 'patch 仍含 U+FFFD') };
      }
      return { ok: true };
    }
    case 'VERSION_CONFLICT': {
      // C3 修复：verify 校验"动作修改后"的 plugins（pin-compatible 已写回
      // resolvedVersion）——此前校验的是未变更的原始列表，纯属同义反复。
      const { checkConflicts } = require('../domain/conflicts');
      const c = checkConflicts(ctx.plugins || []);
      return c.ok ? { ok: true } : { ok: false, error: makeError('ERR_CONFLICT_BLOCKED', '仍存在冲突') };
    }
    case 'BUNDLE_MISCLASSIFY': {
      // 重读 profile package.json：bundles 中不得残留 dsh.bundle.patch===false 的插件
      const fsPort = core.ports.fs;
      const path = require('path');
      const manifestFile = path.join(ctx.profile, 'package.json');
      if (!fsPort.existsSync(manifestFile)) {
        return { ok: false, error: makeError('ERR_HEAL_ROLLBACK', 'profile package.json 不存在，无法验证 bundles') };
      }
      let manifest;
      try {
        manifest = JSON.parse(fsPort.readFileSync(manifestFile, 'utf8'));
      } catch (e) {
        return { ok: false, error: makeError('ERR_HEAL_ROLLBACK', `profile package.json 损坏：${e.message}`) };
      }
      const bundles = (manifest.dsh && manifest.dsh.profile && Array.isArray(manifest.dsh.profile.bundles))
        ? manifest.dsh.profile.bundles : [];
      for (const name of bundles) {
        const p = (ctx.plugins || []).find((x) => x.name === name);
        if (p && p.config && p.config['dsh.bundle.patch'] === false) {
          return { ok: false, error: makeError('ERR_HEAL_ROLLBACK', `bundle 重分类验证失败：${name} 仍在 bundles 中`) };
        }
      }
      return { ok: true };
    }
    case 'GITHUB_ACQUIRE_FAIL': {
      // 验证 github 源插件已落地（node_modules/<name>/package.json 存在）
      const fsPort = core.ports.fs;
      const path = require('path');
      for (const p of ctx.plugins || []) {
        if (p.source.type !== 'github') continue;
        if (!fsPort.existsSync(path.join(ctx.profile, 'node_modules', p.name, 'package.json'))) {
          return { ok: false, error: makeError('ERR_INSTALL_ACQUIRE', `github 插件未落地：${p.name}`) };
        }
      }
      return { ok: true };
    }
    case 'REGISTRY_UNAVAILABLE': {
      // registry 探测：availableVersions 不抛异常且返回 string[] 即视为恢复。
      // A2 修复：await 异步 registry 端口并校验返回值类型（与 reprobe-registry 步骤、
      // domain/resolve.js 的 Array.isArray 防御口径一致）——此前不 await，异步失败被
      // 静默吞成 ok:true（假自愈）+ Promise 拒绝成为未处理拒绝。
      const reg = core.ports && core.ports.registry;
      if (reg && typeof reg.availableVersions === 'function') {
        try {
          const got = await reg.availableVersions('__probe__');
          if (!Array.isArray(got)) {
            return { ok: false, error: makeError('ERR_INSTALL_ACQUIRE', 'registry 探测返回值非法（须为 string[]）') };
          }
          return { ok: true };
        } catch (e) {
          return { ok: false, error: makeError('ERR_INSTALL_ACQUIRE', `registry 仍不可用：${e.message}`) };
        }
      }
      return { ok: true }; // 无 registry 端口（空实现）视为恢复
    }
    case 'HARNESS_FIX': {
      const probe = core.infra.harness.findHarness(core, { probe: true });
      return probe.ok ? { ok: true } : { ok: false, error: probe.error };
    }
    default:
      return { ok: true };
  }
}

/**
 * 回滚动作。
 * @param {object} core
 * @param {object} action
 * @param {object} ctx
 * @returns {Promise<{ok: boolean, error?: Error}>}
 */
async function rollbackAction(core, action, ctx) {
  try {
    return rollbackActionUnchecked(core, action, ctx);
  } catch (e) {
    return { ok: false, error: makeError('ERR_HEAL_ROLLBACK', `回滚异常：${e && e.message ? e.message : e}`) };
  }
}

/** rollbackAction 的核心实现（异常由 rollbackAction 统一捕获归一为 {ok:false}）。 */
function rollbackActionUnchecked(core, action, ctx) {
  // 参考实现：回滚统一走快照恢复（若有）。
  // R4 修复：回滚判定按结构化 rollbackType（'snapshot'=快照回滚；'none'=无回滚），
  // 不再用 rollback 描述文案当 truthy 门——此前只读探测动作（REGISTRY_UNAVAILABLE/
  // HARNESS_FIX 的 rollback='无（只读探测）'）也会在快照存在时误触快照回滚，
  // 把「探测失败」错误地变成「撤销上次启动」。
  if (action.rollbackType === 'snapshot' && ctx.state && ctx.state.rollback && ctx.state.rollback.snapshot) {
    const { restoreSnapshot } = require('./snapshot');
    // B1 修复：回滚目标做根域 realpath 越界校验（ctx.profileRoot 由 buildHealContext 注入）
    const r = restoreSnapshot(core.ports.fs, ctx.state.rollback.snapshot, ctx.profile, { root: ctx.profileRoot });
    if (!r.ok) return { ok: false, error: makeError('ERR_HEAL_ROLLBACK', `回滚失败：${r.error.message}`) };
  }
  return { ok: true };
}

module.exports = { verifyAction, rollbackAction };
