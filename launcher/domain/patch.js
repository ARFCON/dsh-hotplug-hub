'use strict';
// domain/patch.js — YAML 结构化生成 cordis.patch.yml（禁字符串拼接）
//
// 审计修复：A（非法 YAML）/ N10（slice 截断毁结构）— 只用 yaml 库序列化，
// 只清洗"值"（patch id），绝不触碰 YAML 结构；生成后立即回读自校验。
// C3 修复：
//   - serializePatch 回读后做语义等价深比较（undefined 配置键不再被静默丢弃）；
//   - validatePatchDocument 复用 ids.validateId 白名单/保留名/控制字符规则，
//     拒绝重复 insert id、纯空白 name、数组 config。
const YAML = require('yaml');
const crypto = require('crypto');
const { isDeepStrictEqual } = require('util');
const { MAX_PATCH_ID_LENGTH } = require('../contracts/constants');
const { makeError } = require('../contracts/errors');
const ids = require('./ids');

/**
 * 生成 patch 插入 id：仅对值做清洗，保留结构；超长时截断并追加哈希后缀保证唯一。
 * @param {string} packId
 * @param {string} pluginId
 * @returns {string}
 */
function patchIdFor(packId, pluginId) {
  const raw = `hp-${packId}-${pluginId}`.toLowerCase();
  const clean = raw.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (clean.length <= MAX_PATCH_ID_LENGTH) return clean;
  // 截断后追加 8 位短哈希：不同源 id 即使共享 64 前缀也不碰撞（QA3 patch id 碰撞修复）
  const digest = crypto.createHash('sha1').update(clean).digest('hex').slice(0, 8);
  return clean.slice(0, MAX_PATCH_ID_LENGTH - 9) + '-' + digest;
}

/**
 * 由 pack 构建 cordis.patch.yml 文档结构（与 DSH 契约一致）。
 * @param {object} pack parseHotpack 产物
 * @returns {{ok: boolean, doc?: Array<object>, error?: Error}}
 */
function buildPatchDocument(pack) {
  if (!pack || !Array.isArray(pack.plugins)) {
    return { ok: false, error: makeError('ERR_YAML_INVALID', 'pack 缺少 plugins 列表') };
  }
  const insert = pack.plugins.map((p) => ({
    id: patchIdFor(pack.id, p.id),
    name: p.name,
    config: p.config && typeof p.config === 'object' ? p.config : {}
  }));
  const doc = [{ insert }];
  const check = validatePatchDocument(doc);
  if (!check.ok) return check;
  return { ok: true, doc };
}

/**
 * 序列化 patch 文档为 YAML 文本；生成后回读自校验（A 修复）。
 * C3 修复：回读后与 built.doc 做 isDeepStrictEqual 语义等价比较——
 * config 中的 undefined 键会被 YAML.stringify 静默丢弃，必须被自校验发现。
 * @param {object} pack
 * @returns {{ok: boolean, doc?: Array<object>, yamlText?: string, error?: Error}}
 */
function serializePatch(pack) {
  const built = buildPatchDocument(pack);
  if (!built.ok) return built;
  // C3 修复：undefined 值在序列化前显式清洗（YAML 无法表达 undefined；
  // 静默丢弃会掩盖配置键丢失），清洗后自校验深比较保证产物语义等价。
  const sanitized = stripUndefined(built.doc);
  let yamlText;
  try {
    yamlText = YAML.stringify(sanitized);
  } catch (e) {
    return { ok: false, error: makeError('ERR_YAML_SERIALIZE', `YAML 序列化失败：${e.message}`) };
  }
  const back = parsePatchYaml(yamlText);
  if (!back.ok) {
    return { ok: false, error: makeError('ERR_YAML_SERIALIZE', `生成的 YAML 无法回读：${back.error.message}`) };
  }
  if (!isDeepStrictEqual(back.doc, sanitized)) {
    return { ok: false, error: makeError('ERR_YAML_SERIALIZE', '生成的 YAML 回读后与源文档语义不等价（自校验失败）') };
  }
  return { ok: true, doc: built.doc, yamlText };
}

/** 深清洗 undefined 值（数组/对象递归；undefined 键删除、undefined 元素置 null）。 */
function stripUndefined(value) {
  if (Array.isArray(value)) {
    return value.map((v) => (v === undefined ? null : stripUndefined(v)));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[k] = stripUndefined(v);
    }
    return out;
  }
  return value;
}

/**
 * 解析并校验 cordis.patch.yml 文本。
 * @param {string} text
 * @returns {{ok: boolean, doc?: Array<object>, error?: Error}}
 */
function parsePatchYaml(text) {
  let doc;
  try {
    doc = YAML.parse(text);
  } catch (e) {
    return { ok: false, error: makeError('ERR_YAML_PARSE', `YAML 解析失败：${e.message}`) };
  }
  const check = validatePatchDocument(doc);
  if (!check.ok) return check;
  return { ok: true, doc };
}

/**
 * 校验 patch 文档结构（顶层序列 + insert + id/name/config）。
 * C3 修复：id 复用 ids.validateId 白名单/保留名/控制字符/尾部点空格规则；
 * 拒绝重复 insert id、纯空白 name、数组 config（须为普通对象）。
 * @param {unknown} doc
 * @returns {{ok: boolean, error?: Error}}
 */
function validatePatchDocument(doc) {
  if (!Array.isArray(doc) || doc.length === 0) {
    return { ok: false, error: makeError('ERR_YAML_INVALID', 'patch 文档必须是非空数组') };
  }
  const seenIds = new Set();
  for (const block of doc) {
    if (!block || typeof block !== 'object' || !Array.isArray(block.insert)) {
      return { ok: false, error: makeError('ERR_YAML_INVALID', '每个 patch 块必须包含 insert 数组') };
    }
    for (const item of block.insert) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return { ok: false, error: makeError('ERR_YAML_INVALID', 'insert 项必须是对象') };
      }
      if (typeof item.id !== 'string' || item.id.length === 0 || item.id.length > MAX_PATCH_ID_LENGTH) {
        return { ok: false, error: makeError('ERR_YAML_INVALID', `insert.id 非法：${JSON.stringify(item.id)}`) };
      }
      // C3 修复：id 必须过统一白名单（含保留设备名/控制字符/尾部点空格拒绝）
      const idCheck = ids.validateId(item.id);
      if (!idCheck.ok) {
        return { ok: false, error: makeError('ERR_YAML_INVALID', `insert.id 非法：${idCheck.error.message}`) };
      }
      if (seenIds.has(item.id)) {
        return { ok: false, error: makeError('ERR_YAML_INVALID', `insert.id 重复：${item.id}`) };
      }
      seenIds.add(item.id);
      if (typeof item.name !== 'string' || item.name.length === 0 || !item.name.trim()) {
        return { ok: false, error: makeError('ERR_YAML_INVALID', 'insert.name 缺失或为空白') };
      }
      if (!item.config || typeof item.config !== 'object' || Array.isArray(item.config)) {
        return { ok: false, error: makeError('ERR_YAML_INVALID', 'insert.config 必须是普通对象') };
      }
    }
  }
  return { ok: true };
}

module.exports = { patchIdFor, buildPatchDocument, serializePatch, parsePatchYaml, validatePatchDocument };
