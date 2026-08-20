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
  const steps = action.steps || [];
  for (const step of steps) {
    let r = { ok: true };
    switch (step.type) {
      case 'reinstall': {
        const { installPlugins } = require('./install');
        r = await installPlugins(core, ctx.plugins || [], { profile: ctx.profile });
        break;
      }
      case 'rollback-snapshot': {
        const { restoreSnapshot } = require('./snapshot');
        const snap = ctx.state && ctx.state.rollback && ctx.state.rollback.snapshot;
        if (!snap) r = { ok: false, error: makeError('ERR_HEAL_ROLLBACK', '无可用快照可回滚') };
        else r = restoreSnapshot(core.ports.fs, snap, ctx.profile);
        break;
      }
      case 'disable-recent': {
        // CRASH_LOOP 的实质修复步骤：禁用最近一次变更的插件
        // （隔离进 state.heal.quarantined，由 quarantine 回调持久化）。
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
        // 重建 path 源链接：校验目标存在并复制 package.json
        const fsPort = core.ports.fs;
        const path = require('path');
        for (const p of ctx.plugins || []) {
          if (p.source.type !== 'path') continue;
          const target = p.installPath;
          if (!target || !fsPort.existsSync(target)) {
            r = { ok: false, error: makeError('ERR_INSTALL_DEP', `path 目标不存在：${target}`) };
            break;
          }
          const linkDir = path.join(ctx.profile, 'node_modules', p.name);
          fsPort.mkdirSync(path.dirname(linkDir), { recursive: true });
          fsPort.mkdirSync(linkDir, { recursive: true });
          const srcPkg = path.join(target, 'package.json');
          if (fsPort.existsSync(srcPkg)) fsPort.copyFileSync(srcPkg, path.join(linkDir, 'package.json'));
        }
        break;
      }
      case 'reclassify-bundles': {
        // bundle↔cordis 重分类：重写 profile package.json 的 dsh.profile.bundles
        const fsPort = core.ports.fs;
        const path = require('path');
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
          try {
            fsPort.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
          } catch (writeErr) {
            // C1 修复：写路径不裸抛（此前异常穿透到 index.js FATAL）
            r = { ok: false, error: makeError('ERR_HEAL_ROLLBACK', `重写 profile package.json 失败：${writeErr.message}`) };
            break;
          }
        }
        break;
      }
      case 'regenerate-patch': {
        // 重新生成 cordis.patch.yml（UTF-8 损坏修复）
        const { serializePatch } = require('../domain/patch');
        const path = require('path');
        const patchFile = path.join(ctx.profile, 'cordis.patch.yml');
        const pack = ctx.pack || { id: ctx.state && ctx.state.id, plugins: ctx.plugins || [] };
        const sp = serializePatch(pack);
        if (!sp.ok) r = { ok: false, error: sp.error };
        else {
          try {
            core.ports.fs.writeFileSync(patchFile, sp.yamlText, 'utf8');
          } catch (writeErr) {
            // C1 修复：写路径不裸抛
            r = { ok: false, error: makeError('ERR_YAML_SERIALIZE', `重写 cordis.patch.yml 失败：${writeErr.message}`) };
          }
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
