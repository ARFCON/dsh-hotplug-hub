'use strict';
// domain/assembly.js — 读取 + 校验 assembly（hotpack 1.0，纯函数，零副作用）
//
// v5 重构：解析逻辑单一真源 = shared-core format/hotpack（launcher 语义基线）；
// 本文件为兼容适配层：shared 返回 {ok, code, message}，此处转换为 launcher 历史
// 契约 {ok, error: Error}（调用方读 .error.code / .error.exitCode）。
const { makeError } = require('../contracts/errors');
const shared = require('@dsh/shared-core/format/hotpack');

/**
 * 解析并校验 hotpack 1.0 输入（对象或 JSON 字符串）。
 * @param {unknown|string} input
 * @returns {{ok: boolean, pack?: object, error?: Error}}
 */
function parseHotpack(input) {
  const r = shared.parseHotpack(input);
  if (!r.ok) return { ok: false, error: makeError(r.code, r.message) };
  return { ok: true, pack: r.pack };
}

/**
 * validateAssembly 别名：语义化入口。
 * @param {unknown|string} input
 * @returns {{ok: boolean, pack?: object, error?: Error}}
 */
function validateAssembly(input) {
  return parseHotpack(input);
}

/**
 * legacy 装配解析（兼容旧 core.js 的 {packId, bundles} 形态）。
 * @param {object} raw 已解析的 legacy 对象
 * @returns {{ok: boolean, pack?: object, error?: Error}}
 */
function parseLegacy(raw) {
  const r = shared.parseLegacy(raw);
  if (!r.ok) return { ok: false, error: makeError(r.code, r.message) };
  return { ok: true, pack: r.pack };
}

module.exports = { parseHotpack, validateAssembly, parseLegacy };
