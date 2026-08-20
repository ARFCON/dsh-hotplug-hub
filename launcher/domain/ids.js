'use strict';
// domain/ids.js — id / 包名 / 版本 / 路径校验（纯函数，零副作用）
//
// 审计修复：
//   - D/N30/N31/N32/N43：id 强校验 + 路径归一化越界防护 + 14 向量矩阵全拒
//   - N35：source.path / source.repo 零校验修复
const path = require('path');
const semver = require('semver');
const {
  PACK_ID_RE,
  PLUGIN_NAME_RE,
  EXACT_VERSION_RE,
  RESERVED_WIN_NAMES,
  MAX_ID_LENGTH,
  MAX_SOURCE_PATH_LENGTH
} = require('../contracts/constants');
const { makeError } = require('../contracts/errors');

// C2 修复：控制字符检查补 C1 区（U+0080–U+009F，如 NEL U+0085），
// 防止易混淆字符进入 source.path/repo/ref。
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f\u0080-\u009f]/;
const TRAILING_DOT_OR_SPACE_RE = /[. ]$/;

/**
 * 校验 CLI id：白名单正则 + 长度 + 保留设备名 + 控制字符 + 尾部点/空格。
 * @param {unknown} id
 * @returns {{ok: boolean, id?: string, error?: Error}}
 */
function validateId(id) {
  if (typeof id !== 'string') {
    return { ok: false, error: makeError('ERR_ARG_INVALID_ID', 'id 必须是字符串') };
  }
  if (id.length === 0 || id.length > MAX_ID_LENGTH) {
    return { ok: false, error: makeError('ERR_ARG_INVALID_ID', `id 长度必须在 1..${MAX_ID_LENGTH} 之间`) };
  }
  if (!PACK_ID_RE.test(id)) {
    return { ok: false, error: makeError('ERR_ARG_INVALID_ID', `id 非法（须匹配 ${PACK_ID_RE}）`) };
  }
  if (CONTROL_CHAR_RE.test(id)) {
    return { ok: false, error: makeError('ERR_ARG_INVALID_ID', 'id 不得包含控制字符') };
  }
  if (TRAILING_DOT_OR_SPACE_RE.test(id)) {
    return { ok: false, error: makeError('ERR_ARG_INVALID_ID', 'id 不得以 . 或空格结尾') };
  }
  const base = id.split('.')[0].toUpperCase();
  if (RESERVED_WIN_NAMES.has(base)) {
    return { ok: false, error: makeError('ERR_ARG_INVALID_ID', `id 使用了 Windows 保留设备名 ${base}`) };
  }
  return { ok: true, id };
}

/**
 * 穿越防护：判断 target 是否位于 root 之内（统一走 path.relative 通道）。
 * @param {string} root
 * @param {string} target
 * @returns {boolean}
 */
function isWithin(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

/**
 * 校验 target 位于 root 之内；否则返回路径越界错误。
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
 * 归一化并校验 id 拼接后的路径仍在 root 内（统一通道，防 path.join 穿越）。
 * @param {string} id
 * @param {string} root
 * @returns {{ok: boolean, id?: string, error?: Error}}
 */
function normalizeAndAssert(id, root) {
  const v = validateId(id);
  if (!v.ok) return v;
  const target = path.join(root, id);
  const w = assertWithin(root, target, `id=${id}`);
  if (!w.ok) return w;
  return { ok: true, id };
}

/**
 * 校验插件 id（assembly 内字段）。
 * @param {unknown} pid
 * @returns {{ok: boolean, error?: Error}}
 */
function validatePluginId(pid) {
  if (typeof pid !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(pid)) {
    return { ok: false, error: makeError('ERR_ASSEMBLY_FIELD', `插件 id 非法：${JSON.stringify(pid)}`) };
  }
  return { ok: true };
}

/**
 * Windows 安全名检查（N43 复用）：保留设备名 + 尾部点/空格 + 控制字符。
 * 供 CLI id 与插件名共用——插件 name 会被用作 node_modules/<name> 目录名，
 * 必须与 CLI id 同等防护（C2 修复：此前 CON/NUL/pkg. 等可通过校验并进入文件系统）。
 * @param {string} name 待检查的（单段）名称
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
 * 校验 npm 包名（含 Windows 安全名检查，C2 修复）。
 * @param {unknown} name
 * @returns {{ok: boolean, error?: Error}}
 */
function validatePluginName(name) {
  if (typeof name !== 'string' || !PLUGIN_NAME_RE.test(name)) {
    return { ok: false, error: makeError('ERR_ASSEMBLY_FIELD', `插件名不是合法 npm 包名：${JSON.stringify(name)}`) };
  }
  // 对每个路径段（scoped 包 @scope/name 取末段）做 Windows 安全名检查
  const segments = name.split('/');
  for (const seg of segments) {
    const w = checkWindowsSafeName(seg, '插件名');
    if (!w.ok) return w;
  }
  return { ok: true };
}

/**
 * 校验精确版本号（C2 修复：正则 + semver.valid 双条件——EXACT_VERSION_RE
 * 会放行 '1.02.3'/'1.2.3-a..b' 等 semver 非法串，导致 conflicts 把真实版本
 * 冲突降级为 warning、install 把非法版本交给 npm）。
 * @param {unknown} version
 * @returns {{ok: boolean, error?: Error}}
 */
function validateVersion(version) {
  if (typeof version !== 'string' || !EXACT_VERSION_RE.test(version) || semver.valid(version) === null) {
    return { ok: false, error: makeError('ERR_ASSEMBLY_FIELD', `version 必须是精确版本：${JSON.stringify(version)}`) };
  }
  return { ok: true };
}

/**
 * 校验 source.path（N35 + C2 修复：拒绝控制字符/空/超长/UNC/穿越段/尾部点空格）。
 * C6 修复：拒绝相对路径——相对路径的目标随进程 CWD 漂移（manifest link: 依赖
 * 与 junction 目标都会指向错误位置），且可能逃逸装配根；只有绝对路径语义确定。
 * 平台无关判定：POSIX 的 isAbsolute 不认 'C:/x'，Windows 的 isAbsolute 不认 '/x'，
 * 统一按「盘符绝对 或 path.isAbsolute 或 / 开头」判定。
 * @param {unknown} p
 * @returns {{ok: boolean, error?: Error}}
 */
function validateSourcePath(p) {
  if (typeof p !== 'string' || p.length === 0) {
    return { ok: false, error: makeError('ERR_ASSEMBLY_FIELD', 'path 源必须提供 source.path') };
  }
  if (p.length > MAX_SOURCE_PATH_LENGTH) {
    return { ok: false, error: makeError('ERR_ASSEMBLY_FIELD', `source.path 过长（>${MAX_SOURCE_PATH_LENGTH}）`) };
  }
  if (CONTROL_CHAR_RE.test(p)) {
    return { ok: false, error: makeError('ERR_ASSEMBLY_FIELD', 'source.path 不得包含控制字符') };
  }
  if (/^(\\\\|\/\/)/.test(p)) {
    return { ok: false, error: makeError('ERR_ASSEMBLY_FIELD', 'source.path 不得为 UNC 网络路径') };
  }
  const isAbs = path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/');
  if (!isAbs) {
    return { ok: false, error: makeError('ERR_ASSEMBLY_FIELD', 'source.path 必须为绝对路径（相对路径随 CWD 漂移，已拒绝）') };
  }
  // 穿越段拒绝（C2 修复：'../x'、'..\\x'、'a/../../../x'、'a\\..\\..\\x' 全拒；
  // 绝对路径中的 '..' 段同样禁止，防止链接目标逃逸）
  const segments = String(p).split(/[\\/]/);
  for (const seg of segments) {
    if (seg === '..' || seg === '.') {
      return { ok: false, error: makeError('ERR_ASSEMBLY_FIELD', 'source.path 不得包含 . 或 .. 路径段') };
    }
    const w = checkWindowsSafeName(seg, 'source.path 段');
    if (!w.ok) return w;
  }
  return { ok: true };
}

/**
 * 校验 source.repo（N35 + C2 修复：补长度预算 512，拒绝控制字符）。
 * @param {unknown} repo
 * @returns {{ok: boolean, error?: Error}}
 */
function validateSourceRepo(repo) {
  if (typeof repo !== 'string' || repo.length === 0) {
    return { ok: false, error: makeError('ERR_ASSEMBLY_FIELD', 'github 源必须提供 source.repo') };
  }
  if (repo.length > 512) {
    return { ok: false, error: makeError('ERR_ASSEMBLY_FIELD', 'source.repo 过长（>512）') };
  }
  if (CONTROL_CHAR_RE.test(repo)) {
    return { ok: false, error: makeError('ERR_ASSEMBLY_FIELD', 'source.repo 不得包含控制字符') };
  }
  return { ok: true };
}

/**
 * 校验 source.ref（FIX-14：拒路径分隔符/../控制字符/超长，防 link 越界与命令参数注入）。
 * @param {unknown} ref
 * @returns {{ok: boolean, error?: Error}}
 */
function validateSourceRef(ref) {
  if (typeof ref !== 'string' || ref.length === 0) {
    return { ok: false, error: makeError('ERR_ASSEMBLY_FIELD', 'github 源必须提供 source.ref') };
  }
  if (ref.length > 256) {
    return { ok: false, error: makeError('ERR_ASSEMBLY_FIELD', 'source.ref 过长（>256）') };
  }
  if (CONTROL_CHAR_RE.test(ref)) {
    return { ok: false, error: makeError('ERR_ASSEMBLY_FIELD', 'source.ref 不得包含控制字符') };
  }
  if (/[\\/]/.test(ref) || ref.includes('..') || /^[.]+$/.test(ref)) {
    return { ok: false, error: makeError('ERR_ASSEMBLY_FIELD', 'source.ref 不得包含路径分隔符或 ..') };
  }
  return { ok: true };
}

// 14 向量穿越矩阵（测试用）：全部必须被拒绝
const TRAVERSAL_VECTORS = [
  '..',
  '../x',
  '..\\',
  '..\\x',
  './../x',
  'a/../../../x',
  'a\\..\\..\\..\\x',
  'C:\\Windows',
  '/etc',
  'CON',
  'NUL.txt',
  'COM1',
  '...',
  'abc '
];

module.exports = {
  validateId,
  isWithin,
  assertWithin,
  normalizeAndAssert,
  validatePluginId,
  validatePluginName,
  validateVersion,
  validateSourcePath,
  validateSourceRepo,
  validateSourceRef,
  TRAVERSAL_VECTORS,
  PACK_ID_RE,
  PLUGIN_NAME_RE,
  EXACT_VERSION_RE
};
