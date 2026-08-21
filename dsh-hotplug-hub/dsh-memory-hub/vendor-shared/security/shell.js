'use strict';
// security/shell.js — 命令安全契约（H-7 / R-v5-9，CONTRACT.md 钉死）
//
// 原则：不构造 shell 字符串——一律 spawn 数组参数 + shell:false；本模块是
// 「进 shell / 进 argv」自由形态值的唯一清洗点（launcher / vendor / scripts /
// C# 契约共用，含 hotplug runCli）。
//
// 两级校验：
//   - assertShellSafe：严格单段（git ref / tag / profile / 插件名等）；
//     默认字符集 [0-9A-Za-z._-]（首字符字母数字），可经 opts.extraChars 放宽
//     （如 repo 的 '/'）；
//   - assertShellSafeUrl：URL 类值（tarballUrl 等）——非空、无空白/控制字符、
//     无 shell 元字符，且必须 http(s) 协议。

// 可进入 shell 解释的元字符 + 控制字符（C# 侧等价实现见 release/src/PatchContract.cs）
const CMD_SPECIAL_RE = /[\u0000-\u001f\u007f&|;`$()<>"'\\]/;

const URL_RE = /^https?:\/\/[^\s]+$/;

/**
 * 严格单段校验：`^[0-9A-Za-z][0-9A-Za-z._-]*$`（可经 extraChars 放宽）。
 * @param {unknown} value
 * @param {string} [what] 语义名（错误消息用）
 * @param {object} [opts]
 * @param {string} [opts.extraChars] 额外允许字符（如 '/'；会被转义进字符类）
 * @param {number} [opts.maxLength] 长度上限（默认 256）
 * @returns {{ok: boolean, error?: Error}}
 */
function assertShellSafe(value, what = '值', opts = {}) {
  const maxLength = opts.maxLength === undefined ? 256 : opts.maxLength;
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, error: new Error(`${what} 必须是非空字符串`) };
  }
  if (value.length > maxLength) {
    return { ok: false, error: new Error(`${what} 过长（>${maxLength}）`) };
  }
  if (CMD_SPECIAL_RE.test(value) || /\s/.test(value)) {
    return { ok: false, error: new Error(`${what} 含 shell 元字符或空白：${JSON.stringify(value)}`) };
  }
  const extra = typeof opts.extraChars === 'string' && opts.extraChars !== ''
    ? opts.extraChars.replace(/[\\\]\^-]/g, '\\$&')
    : '';
  // 转义后的 extra 插在第二类中部，`.` `_` `-` 固定在类尾部（`-` 在类尾为字面量，
  // 避免 `_ - /` 被解析为降序范围导致 "Range out of order"）；首字符必须字母数字
  const re = new RegExp(`^[0-9A-Za-z][0-9A-Za-z${extra}._-]*$`);
  if (!re.test(value)) {
    return { ok: false, error: new Error(`${what} 含非法字符：${JSON.stringify(value)}`) };
  }
  return { ok: true };
}

/**
 * URL 级校验：http(s) 协议、无空白/控制字符、无 shell 元字符。
 * @param {unknown} value
 * @param {string} [what]
 * @param {object} [opts]
 * @param {number} [opts.maxLength] 长度上限（默认 4096）
 * @returns {{ok: boolean, error?: Error}}
 */
function assertShellSafeUrl(value, what = 'URL', opts = {}) {
  const maxLength = opts.maxLength === undefined ? 4096 : opts.maxLength;
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, error: new Error(`${what} 必须是非空字符串`) };
  }
  if (value.length > maxLength) {
    return { ok: false, error: new Error(`${what} 过长（>${maxLength}）`) };
  }
  if (CMD_SPECIAL_RE.test(value) || /\s/.test(value)) {
    return { ok: false, error: new Error(`${what} 含 shell 元字符或空白`) };
  }
  if (!URL_RE.test(value)) {
    return { ok: false, error: new Error(`${what} 必须是 http(s) URL`) };
  }
  return { ok: true };
}

// 允许的字符类说明（文档用途；C# 侧端口见 CONTRACT.md）
const SHELL_SAFE_LIST = ['0-9', 'A-Z', 'a-z', '.', '_', '-'];

module.exports = { CMD_SPECIAL_RE, assertShellSafe, assertShellSafeUrl, SHELL_SAFE_LIST };
