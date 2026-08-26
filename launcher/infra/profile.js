'use strict';
// infra/profile.js — sandbox → profile 原子同步（先校验后副作用 + 快照回滚）
//
// 审计修复：
//   - H：先校验 harness 与 sandbox，再产生任何写副作用
//   - N31：profile 路径同样走白名单 + 越界防护
//   - P0-1：不再整文件覆盖 profile 的 package.json / cordis.patch.yml——按 dsh.launcher.*
//     标记只替换 launcher 自己的依赖/bundles，cordis.patch.yml 经 mergePatchFile 分节合并；
//   - P1-2：profile/node_modules 为真实目录时移动到备份而非整树删除（数据可恢复）；
//   - P1-3：快照失败即中止同步（无快照保护不做写副作用）。
// C5 修复：node_modules junction 复用条件校验，杜绝"依赖陈旧"。
const path = require('path');
const { PATCH_FILE, PROFILE_MANIFEST, PATCH_LOCK_FILE } = require('../contracts/constants');
const { makeError } = require('../contracts/errors');
const ids = require('../domain/ids');
const { createSnapshot, restoreSnapshot } = require('./snapshot');
const { withPatchLock } = require('./patch-lock');
const { mergePatchFile } = require('@dsh/shared-core/profile/merge');
const { mergeProfileManifest, applyExcludes } = require('./profile-merge');

/**
 * 同步 sandbox 产物到 profile。
 * @param {object} core
 * @param {string} id
 * @param {object} [opts]
 * @param {boolean} [opts.requireHarness] 先校验 harness（H 修复）
 * @param {Array<string>} [opts.exclude] 排除的插件名（quarantine 消费）——
 *   复制后从 profile/package.json 的 dependencies/bundles 与 cordis.patch.yml 的
 *   insert 中剔除，保证被隔离插件不会被 DSH 加载。
 * @param {number} [opts.patchLockWaitMs] 四写者补丁锁等待预算（默认 10000；
 *   测试/特殊调用方可缩短，生产行为不变）
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

  // 2) 分节合并（审计 P0-1 + 四写者锁）
  // 审计修复（四写者锁）：patch/package 写盘纳入 <profile>/.dsh-patch.lock——与 hub 的
  // appendPatchBlock/removePatchBlock 互斥（契约常量 PATCH_LOCK_FILE 在 launcher 侧此前零引用）。
  // 审计修复（P0-1）：不再整文件覆盖 profile 的 package.json / cordis.patch.yml——整文件
  // 覆盖会抹掉 hub/dseam/C# 等其它写者的块与依赖（违反 CONTRACT.md §4「永不整文件覆盖」）。
  // 改为：package.json 按 dsh.launcher.* 标记只替换 launcher 自己的依赖/bundles；
  // cordis.patch.yml 经 mergePatchFile 分节替换 launcher 自己的块。
  // 审计修复（P1-3 + 快照时序）：快照必须在【锁内、自身写盘前】创建——若在锁外创建，
  // 等待锁期间其它写者（hub appendPatchBlock 等）提交的更新会落在快照之前，失败回滚时
  // 把对方刚提交的写盘一并撤销（并发数据丢失）。锁内快照即「launcher 自身写盘前的
  // 权威状态」，回滚只撤销 launcher 自己的半写，不越界撤销他人。快照失败同样中止
  // （无快照保护时不产生写副作用）。
  let snapshot = null;
  const locked = withPatchLock(fsPort, profileDir, () => {
    // 失败统一出口：先回滚快照（若有），再返回结构化错误。
    const fail = (err) => {
      if (snapshot) {
        const rb = restoreSnapshot(fsPort, snapshot, profileDir);
        if (!rb.ok) {
          return { ok: false, error: makeError('ERR_HEAL_ROLLBACK', `同步失败且回滚失败：${rb.error.message}`) };
        }
      }
      return { ok: false, error: err };
    };
    try {
      fsPort.mkdirSync(profileDir, { recursive: true });

      // 锁内快照：紧贴 launcher 自身写盘前（P1-3）。锁文件是共享锁自身，非 profile
      // 产物，应从快照清单剔除——否则回滚会尝试恢复/删除正在使用的锁文件。
      const pre = createSnapshot(fsPort, profileDir, { createdAt: core.ports.now.iso() });
      if (!pre.ok) return { ok: false, error: pre.error };
      if (pre.snapshot.files.some((f) => f.rel === PATCH_LOCK_FILE || f.rel.endsWith(`/${PATCH_LOCK_FILE}`))) {
        pre.snapshot.files = pre.snapshot.files.filter((f) => f.rel !== PATCH_LOCK_FILE && !f.rel.endsWith(`/${PATCH_LOCK_FILE}`));
      }
      if (pre.snapshot.files.length > 0) snapshot = pre.snapshot;

      let sandboxManifest;
      try {
        sandboxManifest = JSON.parse(fsPort.readFileSync(sandboxPkg, 'utf8'));
      } catch (e) {
        return fail(makeError('ERR_INSTALL_DEP', `sandbox package.json 不可解析：${e.message}`));
      }
      const sandboxPatchText = fsPort.existsSync(sandboxPatch)
        ? fsPort.readFileSync(sandboxPatch, 'utf8').replace(/\r?\n+$/, '')
        : null;

      const mergedManifest = mergeProfileManifest(core, fsPort, profileDir, sandboxManifest);
      if (!mergedManifest.ok) return fail(mergedManifest.error);
      if (sandboxPatchText) {
        const mergedPatch = mergePatchFile(fsPort, path.join(profileDir, PATCH_FILE), 'launcher', id, sandboxPatchText);
        if (!mergedPatch.ok) return fail(mergedPatch.error);
      }

      // FIX-1：install 产物打通 —— sandbox/node_modules → profile/node_modules junction
      // （方案 B，与 install-plugins.mjs 对齐：依赖真正落地到 profile 侧，DSH 可 require）
      const sandboxNm = path.join(sandboxResolved, 'node_modules');
      const profileNm = path.join(profileDir, 'node_modules');
      const note = refreshNodeModulesLink(fsPort, sandboxNm, profileNm);
      if (note) syncNote = note;

      // C6 修复（quarantine 消费）：同步后按 exclude 剔除被隔离插件的
      // dependencies/bundles 与 patch insert——不重新组装也能让隔离生效。
      if (exclude.length > 0) {
        const exNote = applyExcludes(core, profileDir, exclude, id);
        if (exNote) syncNote = syncNote ? `${syncNote}；${exNote}` : exNote;
      }
      return { ok: true };
    } catch (e) {
      // 抛错路径（mkdir/read 等裸抛）同样走回滚统一出口
      return fail(makeError('ERR_INSTALL_FAILED', `同步 profile 失败：${e.message}`));
    }
  }, { waitMs: opts.patchLockWaitMs });
  if (!locked.ok) return locked;

  return { ok: true, result: { profile: profileDir, snapshot, note: syncNote } };
}

/**
 * 刷新 profile/node_modules 链接（C5 修复）：
 * - sandbox 无 node_modules → 不动；
 * - profileNm 不存在 → 建 junction（Windows）/dir symlink（POSIX）；
 * - profileNm 是陈旧 junction/symlink → 解链重建指向当前 sandbox（launcher 自身派生的链接，可安全重建）；
 * - profileNm 是【真实目录】→ 该目录只可能由其它写者（hub ensureNpm / dsh plugin add）产生，
 *   不是 launcher 可重建的派生依赖——不做破坏性删除，改为移动到 <profileNm>.bak-<ts> 供回滚/手工恢复；
 * - 链接失败不阻塞同步，返回 note。
 * @param {object} fsPort
 * @param {string} sandboxNm
 * @param {string} profileNm
 * @returns {string|null} note
 */
function refreshNodeModulesLink(fsPort, sandboxNm, profileNm) {
  if (!fsPort.existsSync(sandboxNm)) return null;
  let note = null;
  if (fsPort.existsSync(profileNm)) {
    try {
      const lst = fsPort.lstatSync(profileNm);
      if (lst.isDirectory() && !lst.isSymbolicLink()) {
        // 审计修复（P1-2）：真实目录（非链接）→ 移动到备份目录而非整树删除。
        // 旧实现 rmSync 会把 hub/npm/dsh 落地的真实 node_modules 静默抹掉（不可逆数据丢失）。
        const backup = `${profileNm}.bak-${Date.now()}`;
        fsPort.renameSync(profileNm, backup);
        note = `检测到 profile/node_modules 为真实目录（非 launcher 派生），已移动到备份 ${backup}`;
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
    const linkNote = `node_modules 链接失败：${linkErr.message}`;
    return note ? `${note}；${linkNote}` : linkNote;
  }
  return note;
}

module.exports = { syncProfile, refreshNodeModulesLink, applyExcludes, mergeProfileManifest };
