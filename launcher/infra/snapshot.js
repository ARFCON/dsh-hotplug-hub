'use strict';
// infra/snapshot.js — 快照 / 回滚（manifest 含文件哈希；回滚先备份再覆盖再验证）
//
// 审计修复：H 补救（sync 前快照、失败回滚）；CRASH_LOOP 回滚快照。
// C5 修复：
//   - 二进制文件不再以 utf8 字符串内联（此前 ≤1MB 二进制 toString 产生 U+FFFD，
//     回滚哈希不匹配且目标文件被删除——数据丢失）；
//   - 回滚先全量验证（含 external 源存在性）再删除新增文件（此前先删后验，
//     失败路径残留半回滚状态）；
//   - externalDir 命名唯一化（此前按 createdAt 毫秒命名，固定时钟/同毫秒快照
//     互相覆盖）并在回滚成功后清理；
//   - removePath 处理符号链接/junction（Windows junction 需 rmdir 而非 unlink）；
//   - 回滚/清理不删除符号链接条目（junction 是派生依赖，由下一次 sync 重建）；
//   - cleanupResidue 文件删除逐项容错。
// 目录遍历/删除工具见 infra/tree-util.js（模块 ≤300 行，DoD-16）。
const crypto = require('crypto');
const path = require('path');
const { SNAPSHOT_INLINE_MAX_BYTES } = require('../contracts/constants');
const { makeError } = require('../contracts/errors');
const ids = require('../domain/ids');
const { isValidUtf8 } = require('./monitor');
const { hashBuffer, walkFiles, collectAll, removePath } = require('./tree-util');

/**
 * 创建目录快照。
 * @param {object} fsPort
 * @param {string} dir
 * @param {object} [opts]
 * @param {string} [opts.createdAt] 时间注入
 * @returns {{ok: boolean, snapshot?: object, error?: Error}}
 */
function createSnapshot(fsPort, dir, opts = {}) {
  const createdAt = opts.createdAt || new Date().toISOString();
  if (!fsPort.existsSync(dir)) {
    return { ok: true, snapshot: { dir, createdAt, files: [], externalDir: null } };
  }
  let externalDir = null;
  const files = [];
  for (const f of walkFiles(fsPort, dir, '', [])) {
    if (f.type === 'link') {
      // 记录链接类型（回滚时保留，不删除、不恢复内容）
      files.push({ rel: f.rel, type: 'link' });
      continue;
    }
    try {
      const buf = fsPort.readFileSync(f.abs);
      const hash = hashBuffer(buf);
      // C5 修复：非 UTF-8（二进制）内容一律走 external 字节级复制——
      // utf8 内联会损坏二进制（U+FFFD 替换），回滚哈希必失败。
      if (buf.length <= SNAPSHOT_INLINE_MAX_BYTES && isValidUtf8(buf)) {
        files.push({ rel: f.rel, hash, content: buf.toString('utf8'), size: buf.length, type: 'file' });
      } else {
        // FIX-5：大文件/二进制内容落盘到快照旁备份目录，回滚时可完整恢复
        if (!externalDir) {
          const stamp = createdAt.replace(/[^a-zA-Z0-9._-]/g, '_');
          // C5 修复：追加随机后缀保证唯一（同毫秒/固定时钟两次快照不再互相覆盖）
          const rand = crypto.randomBytes(4).toString('hex');
          externalDir = path.join(path.dirname(dir), `.${path.basename(dir)}.snapbak-${stamp}-${rand}`);
          fsPort.mkdirSync(externalDir, { recursive: true });
        }
        const dest = path.join(externalDir, f.rel);
        fsPort.mkdirSync(path.dirname(dest), { recursive: true });
        fsPort.copyFileSync(f.abs, dest);
        files.push({ rel: f.rel, hash, size: buf.length, external: true, type: 'file' });
      }
    } catch (e) {
      return { ok: false, error: makeError('ERR_HEAL_ROLLBACK', `快照读取失败 ${f.abs}：${e.message}`) };
    }
  }
  return { ok: true, snapshot: { dir, createdAt, files, externalDir } };
}

/**
 * 回滚快照：先备份当前目录到 .rollback-<ts>，再覆盖，最后哈希验证；
 * 并删除快照清单之外的新增文件（QA 修复：回滚彻底，不留 install 残留）。
 * C5 修复：先验证（含 external 源存在性）后删除新增；符号链接/junction 保留。
 * @param {object} fsPort
 * @param {object} snapshot createSnapshot 产物
 * @param {string} dir 目标目录
 * @param {object} [opts]
 * @param {string} [opts.stamp] 备份后缀（默认时间戳）
 * @returns {{ok: boolean, backupDir?: string, removed?: Array<string>, error?: Error}}
 */
function restoreSnapshot(fsPort, snapshot, dir, opts = {}) {
  const stamp = opts.stamp || String(Date.now());
  const backupDir = `${dir}.rollback-${stamp}`;
  const snapshotRels = new Set((snapshot.files || []).filter((f) => f.type !== 'link').map((f) => f.rel));
  try {
    // 1) 备份当前
    if (fsPort.existsSync(dir)) {
      fsPort.rmSync(backupDir, { recursive: true, force: true });
      fsPort.mkdirSync(backupDir, { recursive: true });
      for (const f of walkFiles(fsPort, dir, '', [])) {
        if (f.type === 'link') continue; // 链接不备份内容
        const dest = path.join(backupDir, f.rel);
        fsPort.mkdirSync(path.dirname(dest), { recursive: true });
        fsPort.copyFileSync(f.abs, dest);
      }
    }
    // 2) 覆盖前预验证：external 源存在性（C5 修复：先验后写，失败不产生半回滚）
    for (const f of snapshot.files || []) {
      if (f.external) {
        const extSrc = snapshot.externalDir && path.join(snapshot.externalDir, f.rel);
        if (!extSrc || !fsPort.existsSync(extSrc)) {
          return { ok: false, error: makeError('ERR_HEAL_ROLLBACK', `回滚失败：${f.rel} 的 external 备份缺失`) };
        }
      }
    }
    // 3) 覆盖（FIX-3：写入前逐项越界防护，杜绝 rel=../.. 越界写；
    //    C5 修复：目标若被符号链接占位，先解链再写——防止写入跟随链接逃逸）
    fsPort.mkdirSync(dir, { recursive: true });
    for (const f of snapshot.files || []) {
      if (f.type === 'link') continue;
      const dest = path.join(dir, f.rel);
      const within = ids.assertWithin(dir, dest, `快照文件 ${f.rel}`);
      if (!within.ok) return { ok: false, error: within.error };
      fsPort.mkdirSync(path.dirname(dest), { recursive: true });
      try {
        const lst = fsPort.lstatSync(dest);
        if (lst.isSymbolicLink()) fsPort.unlinkSync(dest);
      } catch (_) { /* 目标不存在则正常写入 */ }
      if (f.external) {
        const extSrc = path.join(snapshot.externalDir, f.rel);
        fsPort.copyFileSync(extSrc, dest);
      } else {
        fsPort.writeFileSync(dest, f.content, 'utf8');
      }
    }
    // 4) 验证（C5 修复：验证通过后才删除快照之外的新增文件——失败时新增仍保留，
    //    且错误携带 backupDir 供二次恢复）
    for (const f of snapshot.files || []) {
      if (f.type === 'link') continue;
      const dest = path.join(dir, f.rel);
      if (!fsPort.existsSync(dest)) {
        return { ok: false, error: makeError('ERR_HEAL_ROLLBACK', `回滚验证失败：${f.rel} 不存在`) };
      }
      const actual = hashBuffer(fsPort.readFileSync(dest));
      if (actual !== f.hash) {
        // FIX-3：验证失败必须删除已写入的目标（含越界残留），避免脏数据落盘
        try { if (fsPort.existsSync(dest)) fsPort.unlinkSync(dest); } catch (_) { /* 忽略 */ }
        return { ok: false, error: makeError('ERR_HEAL_ROLLBACK', `回滚验证失败：${f.rel} 哈希不匹配`, { backupDir }) };
      }
    }
    // 5) 删除新增（验证通过后执行；符号链接/junction 一律保留——派生依赖，
    //    由下一次 sync 重建/刷新）
    const removed = [];
    const isSnapshotPath = (rel) => snapshotRels.has(rel) ||
      [...snapshotRels].some((r) => r.startsWith(rel + '/'));
    const entries = collectAll(fsPort, dir, '', []);
    const extraFiles = entries.filter((e) => !e.isDir && !e.isSymlink && !snapshotRels.has(e.rel));
    const extraDirs = entries.filter((e) => e.isDir && !isSnapshotPath(e.rel))
      .sort((a, b) => b.rel.length - a.rel.length);
    for (const f of extraFiles) {
      removePath(fsPort, f.abs);
      removed.push(f.rel);
    }
    for (const d of extraDirs) {
      try {
        removePath(fsPort, d.abs);
        removed.push(d.rel);
      } catch (_) { /* 目录含快照内容则跳过 */ }
    }
    // 6) C5 修复：回滚成功后清理 externalDir（快照内容已还原，不再需要备份副本）
    if (snapshot.externalDir) {
      try { fsPort.rmSync(snapshot.externalDir, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
    }
    return { ok: true, backupDir, removed };
  } catch (e) {
    return { ok: false, error: makeError('ERR_HEAL_ROLLBACK', `回滚失败：${e.message}`, { cause: e }) };
  }
}

/**
 * 清理目录中"声明产物之外"的残留（N37 修复：reassemble 后已移除插件的残留清除）。
 * 只删除 dir 根内、且不在 keep/keepPrefix 白名单中的条目；目录按深度优先递归删除。
 * @param {object} fsPort
 * @param {string} dir 目标目录
 * @param {object} [opts]
 * @param {string} [opts.root] 越界防护根（如 sandboxRoot）
 * @param {Array<string>} [opts.keep] 顶层保留文件名（如 package.json/cordis.patch.yml）
 * @param {Array<string>} [opts.keepPrefix] 保留的 rel 前缀（如 logs）
 * @returns {{ok: boolean, removed?: Array<string>, error?: Error}}
 */
function cleanupResidue(fsPort, dir, opts = {}) {
  if (opts.root) {
    const within = ids.assertWithin(opts.root, dir, '清理目标');
    if (!within.ok) return { ok: false, error: within.error };
  }
  if (!fsPort.existsSync(dir)) return { ok: true, removed: [] };
  const keep = new Set(opts.keep || []);
  const keepPrefix = (opts.keepPrefix || []).map((p) => (p.endsWith('/') ? p : p + '/'));
  const isKept = (rel) => keep.has(rel) || keepPrefix.some((p) => rel === p.slice(0, -1) || rel.startsWith(p));
  const entries = collectAll(fsPort, dir, '', []);
  // C5 修复：文件删除逐项容错；符号链接/junction 一并删除（removePath 只删链接本身、
  // 不跟随目标——cleanupResidue 语义是"清除残留"，与 restoreSnapshot 的"保留派生链接"
  // 语义不同）。
  const files = entries.filter((e) => !e.isDir && !isKept(e.rel));
  const dirs = entries.filter((e) => e.isDir && !isKept(e.rel)).sort((a, b) => b.rel.length - a.rel.length);
  const removed = [];
  for (const f of files) {
    // C5 修复：文件删除逐项容错（只读文件 EACCES/断链不再让 assemble 崩溃）
    try {
      removePath(fsPort, f.abs);
      removed.push(f.rel);
    } catch (_) { /* 单文件失败跳过 */ }
  }
  for (const d of dirs) {
    try {
      removePath(fsPort, d.abs);
      removed.push(d.rel);
    } catch (_) { /* 目录非空（含保留项）则跳过 */ }
  }
  return { ok: true, removed };
}

/**
 * 快照摘要（manifest 哈希）。
 * @param {object} snapshot
 * @returns {string}
 */
function snapshotDigest(snapshot) {
  const manifest = (snapshot.files || [])
    .map((f) => `${f.rel}:${f.hash || 'link'}`)
    .sort()
    .join('\n');
  return hashBuffer(Buffer.from(manifest, 'utf8'));
}

module.exports = { createSnapshot, restoreSnapshot, snapshotDigest, cleanupResidue, removePath };
