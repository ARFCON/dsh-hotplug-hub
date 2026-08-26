'use strict';
// infra/profile-merge.js — profile package.json / cordis.patch.yml 的分节合并与隔离排除
//
// 审计 P0-1：launcher 不再整文件覆盖 profile 的 package.json / cordis.patch.yml——
// 整文件覆盖会抹掉 hub/dseam/C# 等其它写者的块与依赖（违反 CONTRACT.md §4「永不
// 整文件覆盖」）。本模块提供：
//   - mergeProfileManifest：按 dsh.launcher.* 标记只替换 launcher 自己的依赖/bundles；
//   - applyExcludes：只过滤 launcher 自己的块（marker `## launcher:<id>`）与依赖。
const path = require('path');
const { PATCH_FILE, PROFILE_MANIFEST } = require('../contracts/constants');
const { makeError } = require('../contracts/errors');
const { mergePatchFile, findPatchBlock } = require('@dsh/shared-core/profile/merge');

/**
 * 合并 sandbox manifest 到 profile package.json（审计 P0-1：不整文件覆盖）。
 * 用 dsh.launcher.dependencies / dsh.launcher.bundles 标记追踪 launcher 上次登记的
 * 依赖与 bundles——同步时先移除上次的（陈旧项），再加入本次的，保留其它写者（hub/dseam）
 * 的依赖与 bundles；name/version/private 仅在 profile 侧缺失时从 sandbox 补默认。
 * @param {object} core
 * @param {object} fsPort
 * @param {string} profileDir
 * @param {object} sandboxManifest sandbox package.json（launcher 本次产物）
 * @returns {{ok: boolean, error?: Error}}
 */
function mergeProfileManifest(core, fsPort, profileDir, sandboxManifest) {
  const pkgFile = path.join(profileDir, PROFILE_MANIFEST);
  let profile = {};
  if (fsPort.existsSync(pkgFile)) {
    try {
      profile = JSON.parse(fsPort.readFileSync(pkgFile, 'utf8'));
    } catch (e) {
      // 损坏的 profile package.json 不能静默覆盖——会丢失其它写者的依赖
      return { ok: false, error: makeError('ERR_INSTALL_FAILED', `profile package.json 损坏，拒绝合并：${e.message}`) };
    }
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
      return { ok: false, error: makeError('ERR_INSTALL_FAILED', 'profile package.json 不是对象，拒绝合并') };
    }
  }
  const prev = (profile.dsh && profile.dsh.launcher) || {};
  const hasMarker = Array.isArray(prev.dependencies) || Array.isArray(prev.bundles);

  const sandboxDeps = (sandboxManifest && sandboxManifest.dependencies && typeof sandboxManifest.dependencies === 'object')
    ? sandboxManifest.dependencies : {};
  const sandboxBundles = (sandboxManifest && sandboxManifest.dsh && sandboxManifest.dsh.profile &&
    Array.isArray(sandboxManifest.dsh.profile.bundles)) ? sandboxManifest.dsh.profile.bundles : [];

  const existingDeps = (profile.dependencies && typeof profile.dependencies === 'object') ? profile.dependencies : {};
  const existingBundles = (profile.dsh && profile.dsh.profile && Array.isArray(profile.dsh.profile.bundles))
    ? profile.dsh.profile.bundles : [];

  // 迁移（P0 根因修正）：无 dsh.launcher 标记时，dependencies【绝不删除】任何既有条目——
  // hub（linkEntryIntoProfile）与 C#（dsh plugin add）也会向同一 package.json 追加依赖且
  // 不带标记、不改 name；旧实现用「name 带 dsh-launcher- 前缀」推断「全部是 launcher 上次
  // 写入」会把其它写者的条目一并删除（数据丢失）。陈旧 launcher 依赖残留无害，远优于删他人。
  const prevDepSet = new Set(Array.isArray(prev.dependencies) ? prev.dependencies : []);
  const prevBundleSet = new Set(Array.isArray(prev.bundles) ? prev.bundles : []);

  // 迁移期孤儿 bundle 清理（P0 根因修正，加载敏感）：
  // bundles 与 dependencies 不同——DSH 会【主动加载】dsh.profile.bundles 里每个名字的
  // bundle patch；陈旧 bundle（插件已从 pack 移除、node_modules 已无此插件）会令 DSH
  // 启动失败。且 applyExcludes 按 dsh.launcher.bundles 标记判定所有权——迁移期无标记，
  // 隔离无法剔除陈旧 bundle（假自愈崩溃循环）。
  // 故仅【迁移期（无标记）】对 bundle 做孤儿清理：既不在本次 sandbox 清单、且
  // profile/node_modules 实际也未安装的名字才删除——既不误删其它写者已安装的 bundle，
  // 也消除陈旧 launcher bundle 的启动崩溃。deps 不参与此清理（陈旧依赖无加载副作用）。
  let migrationOrphans = new Set();
  if (!hasMarker) {
    const currentLauncher = new Set([...Object.keys(sandboxDeps), ...sandboxBundles]);
    migrationOrphans = new Set(existingBundles.filter((name) =>
      !currentLauncher.has(name) && !fsPort.existsSync(path.join(profileDir, 'node_modules', name))));
  }

  // dependencies：移除 launcher 上次的（陈旧项），加入本次的（保留其它写者）
  const deps = {};
  for (const [name, spec] of Object.entries(existingDeps)) {
    if (!prevDepSet.has(name)) deps[name] = spec;
  }
  Object.assign(deps, sandboxDeps);

  // bundles：移除 launcher 上次的（陈旧项）+ 迁移期孤儿，加入本次的（保留其它写者，去重）
  const bundles = [];
  const seen = new Set();
  for (const name of existingBundles) {
    if (prevBundleSet.has(name)) continue;
    if (migrationOrphans.has(name)) continue;
    if (!seen.has(name)) { seen.add(name); bundles.push(name); }
  }
  for (const name of sandboxBundles) {
    if (!seen.has(name)) { seen.add(name); bundles.push(name); }
  }

  profile.dependencies = deps;
  profile.dsh = profile.dsh || {};
  profile.dsh.profile = profile.dsh.profile || {};
  profile.dsh.profile.bundles = bundles;
  profile.dsh.launcher = { dependencies: Object.keys(sandboxDeps), bundles: sandboxBundles };

  if (profile.name === undefined) profile.name = sandboxManifest.name || 'dsh-launcher';
  if (profile.version === undefined) profile.version = sandboxManifest.version || '0.1.0';
  if (profile.private === undefined) profile.private = true;

  const w = core.infra.atomic.writeFileAtomic(fsPort, pkgFile, JSON.stringify(profile, null, 2) + '\n');
  if (!w.ok) return { ok: false, error: w.error };
  return { ok: true };
}

/**
 * 从 profile 产物中剔除被隔离插件（C6：quarantine 消费；P0-1 分节感知；P0 根因修正）。
 * - package.json：只删除【launcher 自有】的 dependencies/bundles 条目（按 dsh.launcher.*
 *   标记判定所有权）——绝不用名字全局删除，避免误删 hub/dseam/C# 的同名依赖/bundle；
 * - cordis.patch.yml：只过滤 launcher 自己的块（marker `## launcher:<id>`），经 mergePatchFile
 *   分节替换——绝不触碰其它写者的块。
 * 任一文件缺失/损坏时跳过并返回 note（不破坏既有产物；失败显式可观测）。
 * @param {object} core
 * @param {string} profileDir
 * @param {Array<string>} exclude 插件名列表
 * @param {string} id launcher 块 id（pack id）
 * @returns {string|null} note
 */
function applyExcludes(core, profileDir, exclude, id) {
  const fsPort = core.ports.fs;
  const notes = [];
  const excl = new Set(exclude);
  const pkgFile = path.join(profileDir, PROFILE_MANIFEST);
  if (fsPort.existsSync(pkgFile)) {
    try {
      const manifest = JSON.parse(fsPort.readFileSync(pkgFile, 'utf8'));
      let changed = false;
      // 所有权集合：仅 launcher 在标记中登记的条目可被本次隔离剔除（P0：不越权删他人同名项）
      const launcher = manifest.dsh && manifest.dsh.launcher;
      const ownedDeps = new Set(Array.isArray(launcher && launcher.dependencies) ? launcher.dependencies : []);
      const ownedBundles = new Set(Array.isArray(launcher && launcher.bundles) ? launcher.bundles : []);
      if (manifest.dependencies && typeof manifest.dependencies === 'object') {
        for (const name of Object.keys(manifest.dependencies)) {
          if (ownedDeps.has(name) && excl.has(name)) { delete manifest.dependencies[name]; changed = true; }
        }
      }
      const bundles = manifest.dsh && manifest.dsh.profile && Array.isArray(manifest.dsh.profile.bundles)
        ? manifest.dsh.profile.bundles : null;
      if (bundles) {
        const kept = bundles.filter((n) => !(ownedBundles.has(n) && excl.has(n)));
        if (kept.length !== bundles.length) {
          manifest.dsh.profile.bundles = kept;
          changed = true;
        }
      }
      // launcher 标记同步剔除（保持 dsh.launcher.* 与 dependencies/bundles 一致）
      if (launcher) {
        const ld = launcher;
        if (Array.isArray(ld.dependencies)) {
          const keptDeps = ld.dependencies.filter((n) => !excl.has(n));
          if (keptDeps.length !== ld.dependencies.length) { ld.dependencies = keptDeps; changed = true; }
        }
        if (Array.isArray(ld.bundles)) {
          const keptBundles = ld.bundles.filter((n) => !excl.has(n));
          if (keptBundles.length !== ld.bundles.length) { ld.bundles = keptBundles; changed = true; }
        }
      }
      if (changed) {
        const w = core.infra.atomic.writeFileAtomic(fsPort, pkgFile, JSON.stringify(manifest, null, 2) + '\n');
        if (!w.ok) notes.push(`package.json 排除写入失败：${w.error.message}`);
      }
    } catch (e) {
      notes.push(`package.json 排除失败：${e.message}`);
    }
  }
  const patchFile = path.join(profileDir, PATCH_FILE);
  if (fsPort.existsSync(patchFile)) {
    try {
      const YAML = require('yaml');
      const text = fsPort.readFileSync(patchFile, 'utf8').replace(/\r\n/g, '\n');
      const located = findPatchBlock(text, 'launcher', id);
      if (located.found) {
        const lines = text.split('\n');
        const blockText = lines.slice(located.start + 1, located.end).join('\n');
        const doc = YAML.parse(blockText);
        if (Array.isArray(doc)) {
          let changed = false;
          for (const block of doc) {
            if (!block || !Array.isArray(block.insert)) continue;
            const kept = block.insert.filter((item) => !(item && typeof item.name === 'string' && excl.has(item.name)));
            if (kept.length !== block.insert.length) { block.insert = kept; changed = true; }
          }
          if (changed) {
            const merged = mergePatchFile(fsPort, patchFile, 'launcher', id, YAML.stringify(doc).replace(/\n+$/, ''));
            if (!merged.ok) notes.push(`cordis.patch.yml 排除写入失败：${merged.error.message}`);
          }
        }
      }
    } catch (e) {
      notes.push(`cordis.patch.yml 排除失败：${e.message}`);
    }
  }
  return notes.length > 0 ? `隔离排除部分失败：${notes.join('；')}` : null;
}

module.exports = { mergeProfileManifest, applyExcludes };
