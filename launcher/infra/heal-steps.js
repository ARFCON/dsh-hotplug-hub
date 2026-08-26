'use strict';
// infra/heal-steps.js — 自愈动作的受限步骤执行（单一职责：动作落地）
// 验证/回滚见 infra/heal-verify.js；预算编排见 infra/heal.js（模块 ≤300 行）。
const { makeError } = require('../contracts/errors');

/**
 * 执行单个自愈动作的受限步骤（副作用经 core 注入）。
 * @param {object} core
 * @param {object} action 动作定义（来自 healplan）
 * @param {object} ctx { state, profile, plugins }
 * @returns {Promise<{ok: boolean, result?: object, error?: Error}>}
 */
async function executeAction(core, action, ctx) {
  // H6 修复：null ctx 是调用方错误，显式报错而非裸抛（步骤内访问 ctx.plugins 会 TypeError）。
  if (!ctx || typeof ctx !== 'object') {
    return { ok: false, error: makeError('ERR_HEAL_BUDGET', '自愈上下文缺失（ctx 为空）') };
  }
  try {
    return await executeActionSteps(core, action, ctx);
  } catch (e) {
    // H6 修复：注入侧抛错（onMirror/findHarness 等）统一归一为 {ok:false}，绝不裸抛穿透
    // runHeal/stageHeal——裸抛会使 stageHeal 的失败持久化分支不执行（history/QUARANTINED 丢失）。
    return { ok: false, error: makeError('ERR_HEAL_BUDGET', `自愈步骤执行异常：${e && e.message ? e.message : e}`) };
  }
}

/** executeAction 的核心实现（异常由 executeAction 统一捕获归一为 {ok:false}）。 */
async function executeActionSteps(core, action, ctx) {
  const steps = action.steps || [];
  for (const step of steps) {
    let r = { ok: true };
    switch (step.type) {
      case 'reinstall': {
        const { installPlugins } = require('./install');
        // 审计根因修正：reinstall 落地目标是 sandbox（持久源）——与 stageInstall 一致；
        // 装进 profile 会在下次 launch 的 syncProfile 重新链接 node_modules 时被丢弃。
        // 测试最小 ctx 可能无 sandbox，回退 profile 保持兼容（生产路径 buildHealContext 恒提供 sandbox）。
        r = await installPlugins(core, ctx.plugins || [], { profile: ctx.sandbox || ctx.profile });
        break;
      }
      case 'rollback-snapshot': {
        const { restoreSnapshot } = require('./snapshot');
        const snap = ctx.state && ctx.state.rollback && ctx.state.rollback.snapshot;
        // H2 修复：无快照时回滚不可行，但不应阻断后续实质修复步骤（如 CRASH_LOOP 的
        // disable-recent 隔离崩溃插件）——记为跳过（skip）而非 fatal；快照存在时的
        // 回滚失败仍由 restoreSnapshot 返回 {ok:false} 正常上报。
        if (!snap) r = { ok: true, result: { skipped: true, reason: 'no-snapshot' } };
        // B1 修复：回滚目标做根域 realpath 越界校验（ctx.profileRoot 由 buildHealContext 注入）
        else r = restoreSnapshot(core.ports.fs, snap, ctx.profile, { root: ctx.profileRoot });
        break;
      }
      case 'disable-recent': {
        // CRASH_LOOP 的实质修复步骤：禁用"解析序末位"插件（无变更时间元数据时的
        // 启发式近似"最近变更"；隔离进 state.heal.quarantined，由 quarantine 回调持久化）。
        const targets = ctx.plugins || [];
        const target = targets.length > 0 ? targets[targets.length - 1].name : null;
        if (!target) {
          r = { ok: false, error: makeError('ERR_HEAL_BUDGET', '无插件可禁用（plugins 为空）') };
          break;
        }
        if (ctx.quarantine && typeof ctx.quarantine === 'function') {
          const qr = ctx.quarantine(target);
          r = qr.ok ? { ok: true, result: { disabled: target } } : { ok: false, error: makeError('ERR_HEAL_BUDGET', `禁用插件失败：${qr.error.message}`) };
        } else {
          r = { ok: false, error: makeError('ERR_HEAL_BUDGET', 'quarantine 回调未注入，无法禁用插件') };
        }
        break;
      }
      case 'quarantine': {
        // 将冲突/损坏插件加入隔离列表（记录于 state.heal.quarantined）
        if (ctx.quarantine && typeof ctx.quarantine === 'function') {
          r = ctx.quarantine();
          if (!r.ok) r = { ok: false, error: makeError('ERR_HEAL_BUDGET', `quarantine 失败：${r.error.message}`) };
        } else {
          // FIX-16：无法实现显式报错，不静默 ok:true
          r = { ok: false, error: makeError('ERR_HEAL_BUDGET', 'quarantine 回调未注入，无法隔离插件') };
        }
        break;
      }
      case 'pin-compatible': {
        // VERSION_CONFLICT：重新解析并尝试兼容版本 pin。
        // 新 pin 结果写回 ctx.plugins（引用即 state.resolved.plugins），
        // verify 才能校验"动作修改后的数据"（否则 verify 用旧数据恒冲突）。
        const { resolvePlugins } = require('../domain/resolve');
        const rp = resolvePlugins(ctx.pack || { id: (ctx.state && ctx.state.id), plugins: ctx.plugins || [] }, core.ports.registry);
        if (!rp.ok) r = { ok: false, error: rp.error };
        else {
          const { checkConflicts } = require('../domain/conflicts');
          const cc = checkConflicts(rp.resolved.plugins);
          if (!cc.ok) {
            r = { ok: false, error: makeError('ERR_CONFLICT_BLOCKED', 'pin 兼容版本后仍存在冲突') };
          } else {
            // 写回：把重新解析得到的 resolvedVersion 同步到 ctx.plugins 对应条目
            for (const np of rp.resolved.plugins) {
              const orig = (ctx.plugins || []).find((x) => x.name === np.name);
              if (orig && np.resolvedVersion) orig.resolvedVersion = np.resolvedVersion;
            }
            r = { ok: true, result: { repinned: rp.resolved.plugins.map((p) => `${p.name}@${p.resolvedVersion}`) } };
          }
        }
        break;
      }
      case 'mirror-retry': {
        // 依次切换镜像源重试（github 获取失败 / registry 不可用）
        const mirrors = step.mirrors || [];
        let lastErr = null;
        let succeeded = false;
        for (const mirror of mirrors) {
          if (ctx.onMirror && typeof ctx.onMirror === 'function') {
            const mr = await ctx.onMirror(mirror);
            if (mr && mr.ok) { r = { ok: true, result: { mirror } }; succeeded = true; break; }
            lastErr = mr && mr.error;
          }
        }
        // 无 onMirror 或全部镜像失败 → 显式失败，不得静默 ok:true
        if (!succeeded) {
          r = { ok: false, error: lastErr || makeError('ERR_HEAL_BUDGET', '镜像重试不可用（onMirror 未注入）') };
        }
        break;
      }
      case 'rebuild-link': {
        // R3：复用 installPathPlugin（单一真源）——此前手搓 mkdir+copy package.json
        // （复制壳），自愈后插件劣化：无真实链接（DSH require 不到代码）、陈旧占位
        // 目录不被清理（复制壳混进残留垃圾）。installPathPlugin 的语义与 install
        // 阶段完全一致（校验目标存在 → 清占位 → junction/dir symlink → 失败回退复制壳）。
        // 审计根因修正：落地目标 = sandbox（持久源），与 install 阶段一致。
        const { installPathPlugin } = require('./install');
        const linkProfile = ctx.sandbox || ctx.profile;
        for (const p of ctx.plugins || []) {
          if (p.source.type !== 'path') continue;
          const lr = installPathPlugin(core, p, linkProfile);
          if (!lr.ok) {
            r = { ok: false, error: lr.error };
            break;
          }
        }
        break;
      }
      case 'reclassify-bundles': {
        // bundle↔cordis 重分类：重写 profile package.json 的 dsh.profile.bundles
        const fsPort = core.ports.fs;
        const path = require('path');
        // R3：原子写直依赖本地 shim（与 ./install 的 require 模式一致）——此前
        // writeFileSync 裸写 profile 产物，崩溃时留下半截 package.json；且不经
        // core.infra.atomic（最小测试内核无该字段）。
        const { writeFileAtomic } = require('./atomic');
        const manifestFile = path.join(ctx.profile, 'package.json');
        if (fsPort.existsSync(manifestFile)) {
          let manifest;
          try {
            manifest = JSON.parse(fsPort.readFileSync(manifestFile, 'utf8'));
          } catch (parseErr) {
            // FIX-21：损坏 manifest 显式报错（自愈场景不允许崩溃）
            r = { ok: false, error: makeError('ERR_HEAL_ROLLBACK', `profile package.json 损坏：${parseErr.message}`) };
            break;
          }
          const dsh = manifest.dsh || {};
          const bundles = Array.isArray(dsh.profile && dsh.profile.bundles) ? dsh.profile.bundles : [];
          const fixed = bundles.filter((name) => {
            const p = (ctx.plugins || []).find((x) => x.name === name);
            return !p || (p.config && p.config['dsh.bundle.patch'] !== false);
          });
          manifest.dsh = manifest.dsh || {};
          manifest.dsh.profile = manifest.dsh.profile || {};
          manifest.dsh.profile.bundles = fixed;
          // R3：原子写（writeFileAtomic tmp+rename）——此前 writeFileSync 裸写
          // profile 产物，崩溃时留下半截 package.json（违反统一原子写原则）。
          const w = writeFileAtomic(fsPort, manifestFile, JSON.stringify(manifest, null, 2) + '\n');
          if (!w.ok) {
            // C1 修复：写路径不裸抛（此前异常穿透到 index.js FATAL）
            r = { ok: false, error: makeError('ERR_HEAL_ROLLBACK', `重写 profile package.json 失败：${w.error.message}`) };
            break;
          }
        }
        break;
      }
      case 'regenerate-patch': {
        // 重新生成 cordis.patch.yml（UTF-8 损坏修复）——分节合并，不整文件覆盖（P0-1）
        const { serializePatch } = require('../domain/patch');
        const { withPatchLock } = require('./patch-lock');
        const { mergePatchFile } = require('@dsh/shared-core/profile/merge');
        const path = require('path');
        const patchFile = path.join(ctx.profile, 'cordis.patch.yml');
        const pack = ctx.pack || { id: ctx.state && ctx.state.id, plugins: ctx.plugins || [] };
        const sp = serializePatch(pack);
        if (!sp.ok) r = { ok: false, error: sp.error };
        else if (!pack.id) {
          r = { ok: false, error: makeError('ERR_YAML_SERIALIZE', '重新生成 patch 缺少 pack id，无法分节合并') };
        } else {
          // 审计修复（四写者锁 + P0-1）：regenerate-patch 与 hub 分节保留合并互斥，且
          // 只替换 launcher 自己的块（<profile>/.dsh-patch.lock，CONTRACT.md §4/§5——
          // 此前 launcher 此写点不取锁且整文件覆盖，会抹掉 hub 块）。
          r = withPatchLock(core.ports.fs, ctx.profile, () => {
            const merged = mergePatchFile(core.ports.fs, patchFile, 'launcher', pack.id, sp.yamlText.replace(/\r?\n+$/, ''));
            if (!merged.ok) {
              // C1 修复：写路径不裸抛
              return { ok: false, error: makeError('ERR_YAML_SERIALIZE', `重写 cordis.patch.yml 失败：${merged.error.message}`) };
            }
            return { ok: true };
          });
        }
        break;
      }
      case 'reprobe-harness': {
        // HARNESS_FIX：重新探测可信 harness（只读，无副作用）
        const probe = core.infra.harness.findHarness(core, { probe: true });
        if (!probe.ok) {
          r = { ok: false, error: makeError('ERR_HARNESS_NOT_FOUND', `重新探测 harness 失败：${probe.error.message}`) };
        } else {
          r = { ok: true, result: { harness: probe.harness } };
        }
        break;
      }
      case 'reprobe-registry': {
        // REGISTRY_UNAVAILABLE：重试 registry 探测（npm registry 故障用探测重试，
        // 而非 github 镜像克隆；预算重试由 runHeal 编排）。
        const reg = core.ports && core.ports.registry;
        if (reg && typeof reg.availableVersions === 'function') {
          try {
            // A2 修复：await 异步 registry 端口并校验返回值类型——此前不 await，异步
            // 端口（availableVersions 返回 Promise）的失败不被 try/catch 捕获，被静默
            // 吞成 ok:true（假自愈）且 Promise 拒绝成为未处理拒绝。与 onMirror（已
            // await）及 domain/resolve.js（Array.isArray 防御 Promise 返回值）口径统一。
            const got = await reg.availableVersions('__probe__');
            if (!Array.isArray(got)) {
              r = { ok: false, error: makeError('ERR_INSTALL_ACQUIRE', 'registry 探测返回值非法（须为 string[]）') };
            } else {
              r = { ok: true };
            }
          } catch (e) {
            r = { ok: false, error: makeError('ERR_INSTALL_ACQUIRE', `registry 探测失败：${e.message}`) };
          }
        } else {
          r = { ok: true }; // 无 registry 端口（空实现）视为可用（与 verifyAction 语义一致）
        }
        break;
      }
      default:
        // FIX-16：完全未知步骤显式报错（不静默 ok:true）
        r = { ok: false, error: makeError('ERR_HEAL_BUDGET', `未实现的自愈步骤：${step.type}`) };
        break;
    }
    if (!r.ok) return r;
  }
  // C6 修复（CRASH_LOOP 闭环）：补救步骤全部成功后重置崩溃计数——lastExit/retries 是
  // "最近一次启动"的证据，回滚+禁用后已过期；不重置则 verify 恒读旧崩溃码 →
  // 自愈恒 ERR_HEAL_BUDGET（假自愈）。仅当实际执行了补救步骤才重置
  //（空 steps 的退化动作不得重置——"未修复却宣称 fresh start"）。
  if (action.code === 'CRASH_LOOP' && Array.isArray(action.steps) && action.steps.length > 0 &&
      ctx.state && ctx.state.launch) {
    ctx.state.launch.lastExit = null;
    ctx.state.launch.retries = 0;
    ctx.state.dirty = true;
  }
  return { ok: true };
}

module.exports = { executeAction };
