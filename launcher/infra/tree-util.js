'use strict';
// infra/tree-util.js — 目录树遍历/删除工具（快照/清理共用，纯文件系统操作）
// 与 infra/snapshot.js 分离，保持模块 ≤300 行（DoD-16）。
const path = require('path');
const crypto = require('crypto');

function hashBuffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// 目录条目类型：file / dir / link（符号链接与 Windows junction）
function entryType(ent) {
  if (ent.isSymbolicLink && ent.isSymbolicLink()) return 'link';
  if (ent.isDirectory()) return 'dir';
  if (ent.isFile()) return 'file';
  return 'other';
}

/** 递归遍历目录：输出 {abs, rel, type}（rel 统一正斜杠；链接不跟随目标）。 */
function walkFiles(fsPort, dir, base, out) {
  let entries;
  try {
    entries = fsPort.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const ent of entries) {
    const abs = path.join(dir, ent.name);
    // rel 统一用正斜杠（跨平台：path.join 在 Windows 会产生反斜杠，破坏前缀匹配）
    const rel = base ? `${base}/${ent.name}` : ent.name;
    const type = entryType(ent);
    if (type === 'dir') {
      walkFiles(fsPort, abs, rel, out);
    } else if (type === 'file') {
      out.push({ abs, rel, type: 'file' });
    } else if (type === 'link') {
      // 符号链接/junction 记录但不读取目标内容（防遍历越界/误快照依赖树）
      out.push({ abs, rel, type: 'link' });
    }
  }
  return out;
}

/** 递归收集目录全部条目：输出 {abs, rel, isDir, isSymlink}。 */
function collectAll(fsPort, dir, base, out) {
  let entries;
  try {
    entries = fsPort.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const ent of entries) {
    const abs = path.join(dir, ent.name);
    // rel 统一正斜杠（跨平台一致性）
    const rel = base ? `${base}/${ent.name}` : ent.name;
    const type = entryType(ent);
    out.push({ abs, rel, isDir: type === 'dir', isSymlink: type === 'link' });
    if (type === 'dir') collectAll(fsPort, abs, rel, out);
  }
  return out;
}

/**
 * 删除单个文件或目录树（仅用于快照根内的清理；逐文件 unlink/rmdir，
 * 避免依赖递归 rm 被环境拦截）。
 * 符号链接/junction 走 rmdir 回退（Windows junction 用 unlink 抛 EPERM）。
 * @param {object} fsPort
 * @param {string} target
 * @returns {void}
 */
function removePath(fsPort, target) {
  const st = fsPort.lstatSync(target);
  if (st.isSymbolicLink()) {
    // Windows junction：rmdir 可删；POSIX symlink：unlink 可删——依次尝试
    try {
      fsPort.rmdirSync(target);
    } catch (_) {
      fsPort.unlinkSync(target);
    }
    return;
  }
  if (st.isDirectory()) {
    for (const child of fsPort.readdirSync(target)) {
      removePath(fsPort, path.join(target, child));
    }
    fsPort.rmdirSync(target);
  } else {
    fsPort.unlinkSync(target);
  }
}

module.exports = { hashBuffer, entryType, walkFiles, collectAll, removePath };
