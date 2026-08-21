'use strict';
// infra/profile.js — sandbox → profile 原子同步（先校验后副作用 + 快照回滚）
//
// 审计修复：
//   - H：先校验 harness 与 sandbox，再产生任何写副作用
//   - N31：profile 路径同样走白名单 + 越界防护
//   - N41：日志目录只落 sandbox 侧的问题 —— 同步时只复制产物，logs 由 launch 生成
// C5 修复：
//   - node_modules junction 复用条件校验：profileNm 已存在但指向陈旧 sandbox
//     （上次同步的 junction / dsh 落地的真实目录）时删除重建，杜绝"依赖陈旧"；
//   - 临时文件名为不可预测（随机后缀），防符号链接预置劫持。
const path = require('path');
const crypto = require('crypto');
const { PATCH_FILE, PROFILE_MANIFEST } = require('../contracts/constants');
const { makeError } = require('../contracts/errors');
const ids = require('../domain/ids');
const { createSnapshot, restoreSnapshot } = require('./snapshot');

/**
 * 同步 sandbox 产物到 profile。
 * @param {object} core
 * @param {string} id
 * @param {object} [opts]
 * @param {boolean} [opts.requireHarness] 先校验 harness（H 修复）
 * @param {Array<string>} [opts.exclude] 排除的插件名（quarantine 消费）——
 *   复制后从 profile/package.json 的 dependencies/bundles 与 cordis.patch.yml 的
 *   insert 中剔除，保证被隔离插件不会被 DSH 加载。
 * @returns {{ok: boolean, result?: object, error?: Error}}
 */
function syncProfile(core, id, opts = {}) {
  const { roots } = core.config;
  const fsPort = core.ports.fs;
  let syncNote = null;
  const exclude = Array.isArray(opts.exclude) ? opts.exclude.filter((x) => typeof x === 'string' && x.length > 0) : [];

  // 1) 前置校验（先校验后副作用）
  const idCheck = ids.normalizeAndAssert(id, roots.profilesRoot);
  if (!idCheck.ok) return { ok: false, error: idCheck.error };

  const sandboxDir = path.join(roots.sandboxRoot, id);
  // m7（安全审计）：sandbox 目录同样 realpath 比真根——junction 预置于
  // sandboxRoot/<id> 可把 copyFileSync 源重定向到任意目录；解析失败即拒绝。
  const sandboxCheck = ids.assertWithinRealpath(fsPort, roots.sandboxRoot, sandboxDir, `sandbox(id=${id})`);
  if (!sandboxCheck.ok) return { ok: false, error: sandboxCheck.error };
  const sandboxResolved = sandboxCheck.resolvedPath;
  const sandboxPkg = path.join(sandboxResolved, PROFILE_MANIFEST);
  const sandboxPatch = path.join(sandboxResolved, PATCH_FILE);
  if (!fsPort.existsSync(sandboxPkg)) {
    return { ok: false, error: makeError('ERR_INSTALL_DEP', 'sandbox 不存在，请先执行 assemble') };
  }

  if (opts.requireHarness) {
    const h = core.ports.dsh.findHarness({ platform: core.config.platform });
    if (!h.ok) return { ok: false, error: h.error };
  }

  const profileDirLexical = path.join(roots.profilesRoot, id);
  // C-1 修复（阶段 1）：realpath 整路径比真根——profile 目录不得经符号链接逃出
  // profilesRoot；通过后对解析路径做后续 I/O（m7：此前忽略 resolvedPath 继续用
  // 词法路径写，存在换链窗口；现全程用解析路径，无 TOCTOU）。
  const profileCheck = ids.assertWithinRealpath(fsPort, roots.profilesRoot, profileDirLexical, `profile(id=${id})`);
  if (!profileCheck.ok) return { ok: false, error: profileCheck.error };
  const profileDir = profileCheck.resolvedPath;

  // 2) 快照现有 profile（若有）
  let snapshot = null;
  const pre = createSnapshot(fsPort, profileDir, { createdAt: core.ports.now.iso() });
  if (pre.ok && pre.snapshot.files.length > 0) snapshot = pre.snapshot;

  // 3) 原子复制（C5 修复：临时名带随机后缀，防可预测名符号链接预置）
  let tmpPkg = null;
  let tmpPatch = null;
  try {
    fsPort.mkdirSync(profileDir, { recursive: true });
    const rand = crypto.randomBytes(4).toString('hex');
    tmpPkg = path.join(profileDir, `.${PROFILE_MANIFEST}.${Date.now()}.${rand}.tmp`);
    tmpPatch = path.join(profileDir, `.${PATCH_FILE}.${Date.now()}.${rand}.tmp`);
    fsPort.copyFileSync(sandboxPkg, tmpPkg);
    if (fsPort.existsSync(sandboxPatch)) fsPort.copyFileSync(sandboxPatch, tmpPatch);
    fsPort.renameSync(tmpPkg, path.join(profileDir, PROFILE_MANIFEST));
    if (fsPort.existsSync(sandboxPatch)) fsPort.renameSync(tmpPatch, path.join(profileDir, PATCH_FILE));

    // FIX-1：install 产物打通 —— sandbox/node_modules → profile/node_modules junction
    // （方案 B，与 install-plugins.mjs 对齐：依赖真正落地到 profile 侧，DSH 可 require）
    const sandboxNm = path.join(sandboxResolved, 'node_modules');
    const profileNm = path.join(profileDir, 'node_modules');
    const note = refreshNodeModulesLink(fsPort, sandboxNm, profileNm);
    if (note) syncNote = note;

    // C6 修复（quarantine 消费）：同步后按 exclude 剔除被隔离插件的
    // dependencies/bundles 与 patch insert——不重新组装也能让隔离生效。
    if (exclude.length > 0) {
      const exNote = applyExcludes(core, profileDir, exclude);
      if (exNote) syncNote = syncNote ? `${syncNote}；${exNote}` : exNote;
    }
  } catch (e) {
    // FIX-23：清理未 rename 的 tmp 残留
    try { if (tmpPkg && fsPort.existsSync(tmpPkg)) fsPort.unlinkSync(tmpPkg); } catch (_) { /* 忽略 */ }
    try { if (tmpPatch && fsPort.existsSync(tmpPatch)) fsPort.unlinkSync(tmpPatch); } catch (_) { /* 忽略 */ }
    // 4) 失败回滚
    if (snapshot) {
      const rb = restoreSnapshot(fsPort, snapshot, profileDir);
      if (!rb.ok) {
        return { ok: false, error: makeError('ERR_HEAL_ROLLBACK', `同步失败且回滚失败：${rb.error.message}`) };
      }
    }
    return { ok: false, error: makeError('ERR_INSTALL_FAILED', `同步 profile 失败：${e.message}`) };
  }

  return { ok: true, result: { profile: profileDir, snapshot, note: syncNote } };
}

/**
 * 从 profile 产物中剔除被隔离插件（C6：quarantine 消费）。
 * - package.json：删除 dependencies[excluded] 与 dsh.profile.bundles 中的条目；
 * - cordis.patch.yml：解析后过滤 insert 项（name ∈ exclude），重新序列化。
 * 任一文件缺失/损坏时跳过并返回 note（不破坏既有产物；失败显式可观测）。
 * @param {object} core
 * @param {string} profileDir
 * @param {Array<string>} exclude 插件名列表
 * @returns {string|null} note
 */
function applyExcludes(core, profileDir, exclude) {
  const fsPort = core.ports.fs;
  const notes = [];
  const excl = new Set(exclude);
  const pkgFile = path.join(profileDir, PROFILE_MANIFEST);
  if (fsPort.existsSync(pkgFile)) {
    try {
      const manifest = JSON.parse(fsPort.readFileSync(pkgFile, 'utf8'));
      let changed = false;
      if (manifest.dependencies && typeof manifest.dependencies === 'object') {
        for (const name of Object.keys(manifest.dependencies)) {
          if (excl.has(name)) { delete manifest.dependencies[name]; changed = true; }
        }
      }
      const bundles = manifest.dsh && manifest.dsh.profile && Array.isArray(manifest.dsh.profile.bundles)
        ? manifest.dsh.profile.bundles : null;
      if (bundles) {
        const kept = bundles.filter((n) => !excl.has(n));
        if (kept.length !== bundles.length) {
          manifest.dsh.profile.bundles = kept;
          changed = true;
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
      const doc = YAML.parse(fsPort.readFileSync(patchFile, 'utf8'));
      if (Array.isArray(doc)) {
        let changed = false;
        for (const block of doc) {
          if (!block || !Array.isArray(block.insert)) continue;
          const kept = block.insert.filter((item) => !(item && typeof item.name === 'string' && excl.has(item.name)));
          if (kept.length !== block.insert.length) { block.insert = kept; changed = true; }
        }
        if (changed) {
          // 原子写（副作用集中于一处原则，与 package.json 排除路径一致）
          const w = core.infra.atomic.writeFileAtomic(fsPort, patchFile, YAML.stringify(doc));
          if (!w.ok) notes.push(`cordis.patch.yml 排除写入失败：${w.error.message}`);
        }
      }
    } catch (e) {
      notes.push(`cordis.patch.yml 排除失败：${e.message}`);
    }
  }
  return notes.length > 0 ? `隔离排除部分失败：${notes.join('；')}` : null;
}

/**
 * 刷新 profile/node_modules 链接（C5 修复）：
 * - sandbox 无 node_modules → 不动；
 * - profileNm 不存在 → 建 junction（Windows）/dir symlink（POSIX）；
 * - profileNm 已存在（陈旧 junction 或 dsh/npm 落地的真实目录）→ 删除重建指向当前 sandbox，
 *   杜绝"package.json 已刷新而 node_modules 仍是旧依赖"的静默陈旧；
 * - 链接失败不阻塞同步，返回 note。
 * @param {object} fsPort
 * @param {string} sandboxNm
 * @param {string} profileNm
 * @returns {string|null} note
 */
function refreshNodeModulesLink(fsPort, sandboxNm, profileNm) {
  if (!fsPort.existsSync(sandboxNm)) return null;
  if (fsPort.existsSync(profileNm)) {
    try {
      const lst = fsPort.lstatSync(profileNm);
      if (lst.isDirectory() && !lst.isSymbolicLink()) {
        // 真实目录（非链接）：整树移除后重建链接——该目录是派生依赖，可重建
        fsPort.rmSync(profileNm, { recursive: true, force: true });
      } else if (lst.isSymbolicLink()) {
        // 陈旧 junction/symlink：解链（Windows junction 用 rmdir）
        try {
          fsPort.rmdirSync(profileNm);
        } catch (_) {
          fsPort.unlinkSync(profileNm);
        }
      }
    } catch (e) {
      return `node_modules 刷新失败：${e.message}`;
    }
  }
  try {
    if (typeof fsPort.symlinkSync === 'function') {
      // junction：Windows 无需管理员权限的目录链接；POSIX 等价于 dir symlink
      fsPort.symlinkSync(sandboxNm, profileNm, 'junction');
    }
  } catch (linkErr) {
    // 链接失败不阻塞同步（依赖经 NODE_PATH 或后续 install 仍可恢复），但记录于返回
    return `node_modules 链接失败：${linkErr.message}`;
  }
  return null;
}

module.exports = { syncProfile, refreshNodeModulesLink, applyExcludes };
