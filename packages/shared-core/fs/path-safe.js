'use strict';
// fs/path-safe.js — 路径安全：isWithin / assertWithin（词法）+ realpath 变体
// （C-1 越界防护）与 safeJoin（拒绝集：绝对/盘符/UNC/前导斜杠/../保留名/尾点空格/~，H-5/M-5）
//
// 两级语义（CONTRACT.md §路径安全）：
//   - isWithin/assertWithin：纯词法（path.relative）——用于"目标尚不存在"的预检
//     （如 id 拼接、将创建的文件路径），不做 realpath；
//   - isWithinRealpath/assertWithinRealpath：realpath 整路径比真根（E1/P1 junction
//     越界实证）——用于对"已存在或部分存在"路径的越界判定与写入前检查；
//     通过后必须对返回的 resolvedPath 做后续 I/O（无 TOCTOU：检查后仅用 realpath 结果）。
//     ELOOP/EPERM/EACCES 一律 deny。
const path = require('path');
const { makeError } = require('../contracts/errors');
const { RESERVED_WIN_NAMES } = require('../contracts/constants');

// C2 修复：控制字符检查补 C1 区（U+0080–U+009F，如 NEL U+0085），
// 防止易混淆字符进入路径。
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f\u0080-\u009f]/;
const TRAILING_DOT_OR_SPACE_RE = /[. ]$/;

/**
 * 穿越防护（词法）：判断 target 是否位于 root 之内（path.relative 通道）。
 * 仅用于尚不存在的目标预检；对已存在路径请用 isWithinRealpath（C-1）。
 * @param {string} root
 * @param {string} target
 * @returns {boolean}
 */
function isWithin(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

/**
 * 校验 target 位于 root 之内（词法）；否则返回路径越界错误。
 * @param {string} root
 * @param {string} target
 * @param {string} [what]
 * @returns {{ok: boolean, error?: Error}}
 */
function assertWithin(root, target, what) {
  if (!isWithin(root, target)) {
    return {
      ok: false,
      error: makeError('ERR_ARG_PATH_ESCAPE', `路径越界：${what || '目标'} ${target} 不在根目录 ${root} 内`)
    };
  }
  return { ok: true };
}

/**
 * 解析「最深的已存在祖先」为 realpath，并拼回剩余词法段。
 * 目标整体不存在（将创建）时也能得到确定的真实基座，杜绝符号链接逃逸。
 * @param {object} fsPort fs 端口（须含 existsSync/realpathSync）
 * @param {string} p 绝对目标路径
 * @returns {{ok: boolean, resolved?: string, error?: Error}}
 */
function resolveExistingAncestor(fsPort, p) {
  let current = path.resolve(p);
  const suffix = [];
  for (;;) {
    try {
      if (fsPort.existsSync(current)) {
        let real;
        try {
          real = fsPort.realpathSync(current);
        } catch (e) {
          return { ok: false, error: makeError('ERR_ARG_PATH_ESCAPE', `realpath 失败（${e.code || '未知'}）：${current}`) };
        }
        // suffix 是从下往上收集的（最深→最浅），reverse 后拼回真实基座
        return { ok: true, resolved: suffix.length === 0 ? real : path.join(real, ...suffix.reverse()) };
      }
    } catch (_) { /* stat 失败按不存在处理 */ }
    const parent = path.dirname(current);
    if (parent === current) {
      return { ok: false, error: makeError('ERR_ARG_PATH_ESCAPE', `路径无已存在祖先：${p}`) };
    }
    suffix.push(path.basename(current));
    current = parent;
  }
}

/**
 * 穿越防护（realpath，C-1）：root 与 target 均解析真实路径后整路径比较。
 * 目标不存在时经「最深已存在祖先」解析——junction/symlink 越界一律拒绝；
 * root 自身为软链时以真实根为准（合法软链收）。
 * @param {object} fsPort
 * @param {string} root
 * @param {string} target
 * @returns {boolean}
 */
function isWithinRealpath(fsPort, root, target) {
  const r = realpathWithin(fsPort, root, target);
  return r.ok;
}

/**
 * realpath 越界校验（返回解析后路径供后续 I/O——无 TOCTOU 语义）。
 * @param {object} fsPort
 * @param {string} root 真根
 * @param {string} target 目标（可不存在）
 * @param {string} [what]
 * @returns {{ok: boolean, resolvedPath?: string, error?: Error}}
 */
function assertWithinRealpath(fsPort, root, target, what) {
  const r = realpathWithin(fsPort, root, target);
  if (!r.ok) return r;
  return { ok: true, resolvedPath: r.resolvedPath };
}

/** realpathWithin 内部实现（ok 时带 resolvedPath）。 */
function realpathWithin(fsPort, root, target) {
  // 根可能尚不存在（全新安装）：经最深已存在祖先解析，得到确定的真实基座
  const rootResolved = resolveExistingAncestor(fsPort, path.resolve(root));
  if (!rootResolved.ok) return rootResolved;
  const realRoot = rootResolved.resolved;
  const anc = resolveExistingAncestor(fsPort, path.resolve(target));
  if (!anc.ok) return anc;
  const rel = path.relative(realRoot, anc.resolved);
  const within = rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
  if (!within) {
    return {
      ok: false,
      error: makeError('ERR_ARG_PATH_ESCAPE', `路径越界（realpath）：${target} 的真实位置 ${anc.resolved} 不在根 ${realRoot} 内`)
    };
  }
  return { ok: true, resolvedPath: anc.resolved };
}

/**
 * 检查单段路径名是否可安全用作文件系统条目（Windows 保留名 / 尾点空格 / 控制字符）。
 * 错误码 ERR_ASSEMBLY_FIELD（与 launcher 历史语义一致；safeJoin 场景复用）。
 * @param {string} name 单段名称
 * @param {string} [what]
 * @returns {{ok: boolean, error?: Error}}
 */
function checkWindowsSafeName(name, what) {
  if (CONTROL_CHAR_RE.test(name)) {
    return { ok: false, error: makeError('ERR_ASSEMBLY_FIELD', `${what} 不得包含控制字符`) };
  }
  if (TRAILING_DOT_OR_SPACE_RE.test(name)) {
    return { ok: false, error: makeError('ERR_ASSEMBLY_FIELD', `${what} 不得以 . 或空格结尾`) };
  }
  const base = name.split('.')[0].toUpperCase();
  if (RESERVED_WIN_NAMES.has(base)) {
    return { ok: false, error: makeError('ERR_ASSEMBLY_FIELD', `${what} 使用了 Windows 保留设备名 ${base}`) };
  }
  return { ok: true };
}

/**
 * 安全拼接：每个段必须是「单段安全名」（拒绝绝对/盘符/UNC/前导斜杠/.. /./~/
 * 保留名/尾点空格/控制字符/长度超限），拼接结果必须仍位于 root 之内。
 * @param {string} root 沙箱根（绝对路径）
 * @param {...string} parts 待拼接的路径段
 * @returns {{ok: boolean, path?: string, error?: Error}}
 */
function safeJoin(root, ...parts) {
  const segments = [];
  for (const part of parts) {
    if (typeof part !== 'string' || part.length === 0) {
      return { ok: false, error: makeError('ERR_ARG_PATH_ESCAPE', 'safeJoin 段必须是非空字符串') };
    }
    if (part.length > 255) {
      return { ok: false, error: makeError('ERR_ARG_PATH_ESCAPE', `safeJoin 段过长：${part.length} > 255`) };
    }
    if (part === '.' || part === '..' || part.includes('/') || part.includes('\\')) {
      return { ok: false, error: makeError('ERR_ARG_PATH_ESCAPE', `safeJoin 段非法（不得含路径分隔符或 . / ..）：${JSON.stringify(part)}`) };
    }
    if (part.startsWith('~')) {
      return { ok: false, error: makeError('ERR_ARG_PATH_ESCAPE', 'safeJoin 段不得以 ~ 开头') };
    }
    if (CONTROL_CHAR_RE.test(part)) {
      return { ok: false, error: makeError('ERR_ARG_PATH_ESCAPE', 'safeJoin 段不得包含控制字符') };
    }
    const w = checkWindowsSafeName(part, 'safeJoin 段');
    if (!w.ok) return w;
    segments.push(part);
  }
  const joined = path.join(root, ...segments);
  const within = assertWithin(root, joined, `safeJoin(${segments.join('/')})`);
  if (!within.ok) return within;
  return { ok: true, path: joined };
}

module.exports = {
  isWithin,
  assertWithin,
  isWithinRealpath,
  assertWithinRealpath,
  resolveExistingAncestor,
  safeJoin,
  checkWindowsSafeName,
  CONTROL_CHAR_RE,
  TRAILING_DOT_OR_SPACE_RE
};
