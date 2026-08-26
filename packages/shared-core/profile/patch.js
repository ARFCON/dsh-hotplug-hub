'use strict';
// profile/patch.js — YAML 结构化生成 cordis.patch.yml（禁字符串拼接）
//
// 审计修复：A（非法 YAML）/ N10（slice 截断毁结构）— 只用 yaml 库序列化，
// 只清洗"值"（patch id），绝不触碰 YAML 结构；生成后立即回读自校验。
// C3 修复：
//   - serializePatch 回读后做语义等价深比较（undefined 配置键不再被静默丢弃）；
//   - validatePatchDocument 复用 ids.validateId 白名单/保留名/控制字符规则，
//     拒绝重复 insert id、纯空白 name、数组 config。
//
// 依赖策略：yaml 为**运行时惰性依赖**（仅 serializePatch/parsePatchYaml 函数体内
// require）——vendored 消费方（hotplug/memory，无 yaml 依赖）加载本模块安全；
// 调用 YAML 序列化能力需要宿主提供 yaml（launcher workspace 具备）。
// 阶段 2 待办（M-8）：serializePatch 返回 doc 为清洗后产物（与 yamlText 语义一致）。
const crypto = require('crypto');
const { isDeepStrictEqual } = require('util');
const { MAX_PATCH_ID_LENGTH } = require('../contracts/constants');
const { makeError } = require('../contracts/errors');
const ids = require('../ids');

/**
 * 生成 patch 插入 id：仅对值做清洗，保留结构；无条件追加基于无歧义编码的短哈希
 * 保证单射（跨包/分隔符歧义不碰撞），超长时截断前缀、整体 ≤64。
 * @param {string} packId
 * @param {string} pluginId
 * @returns {string}
 */
function patchIdFor(packId, pluginId) {
  const raw = `hp-${packId}-${pluginId}`.toLowerCase();
  const clean = raw.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  // 注入性修复（审计）：`hp-${packId}-${pluginId}` 用 '-' 拼接，但 '-' 同时是 packId
  // 与 pluginId 的合法字符，拼接不可逆——`patchIdFor('ab-c','d')` 与
  // `patchIdFor('ab','c-d')` 都产出 `hp-ab-c-d`（两对输入各自通过 validateId /
  // validatePluginId，见 test）。原哈希只在超长截断时追加、且对「歧义串」clean 计算，
  // 无法区分歧义输入。现无条件追加基于【无歧义编码】（NUL 分隔 packId/pluginId）的
  // 8 位短哈希，保证单射：同 clean 前缀但源对不同 ⇒ 哈希不同；截断与歧义共用同一哈希。
  const digest = crypto.createHash('sha1')
    .update(`${packId}\u0000${pluginId}`.toLowerCase())
    .digest('hex')
    .slice(0, 8);
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
  const YAML = require('yaml'); // 惰性依赖：仅本函数需要
  const built = buildPatchDocument(pack);
  if (!built.ok) return built;
  // C3 修复：undefined 值在序列化前显式清洗（YAML 无法表达 undefined；
  // 静默丢弃会掩盖配置键丢失），清洗后自校验深比较保证产物语义等价。
  // M-52 修复（v5 阶段 5）：循环引用配置此前在 stripUndefined 中无限递归
  // → RangeError 栈溢出裸抛（C1 违背：自愈 regenerate-patch / assemble 可被
  // 恶意或损坏的 config 击穿为 FATAL）；现显式检出并归一化为 ERR_YAML_SERIALIZE。
  let sanitized;
  try {
    sanitized = stripUndefined(built.doc);
  } catch (e) {
    if (e && e.code === 'ERR_YAML_SERIALIZE') return { ok: false, error: e };
    return { ok: false, error: makeError('ERR_YAML_SERIALIZE', `配置清洗失败：${e.message}`) };
  }
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
  // M-8 修复（v5 阶段 2）：返回 doc 为清洗后产物——doc 与 yamlText 语义一致
  // （此前返回 built.doc（含 undefined 键），与 yamlText 反映的清洗产物不等价，
  // 调用方若消费 doc 会拿到 YAML 无法表达的形态）。
  return { ok: true, doc: sanitized, yamlText };
}

/**
 * 深清洗 undefined 值（数组/对象递归；undefined 键删除、undefined 元素置 null）。
 * M-52 修复：祖先链环检测——循环引用抛 ERR_YAML_SERIALIZE（由 serializePatch
 * 归一化），不再无限递归栈溢出；仅当对象出现在自身祖先链上（真环）才判循环，
 * 共享引用（同一对象被两处引用）属合法输入，不误报。
 */
function stripUndefined(value, ancestors = new WeakSet()) {
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw makeError('ERR_YAML_SERIALIZE', '配置含循环引用，无法序列化');
    ancestors.add(value);
    const out = value.map((v) => (v === undefined ? null : stripUndefined(v, ancestors)));
    ancestors.delete(value);
    return out;
  }
  if (value && typeof value === 'object') {
    // 审计修复（Bug D）：非纯对象（Date/RegExp/Map/Set/类实例）无法被 Object.entries
    // 正确遍历（会被清空为 {}），显式报错而非静默丢数据。config 源自 JSON 时不可达。
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw makeError('ERR_YAML_SERIALIZE', '配置含非纯对象值（Date/RegExp/Map/Set/类实例），无法序列化');
    }
    if (ancestors.has(value)) throw makeError('ERR_YAML_SERIALIZE', '配置含循环引用，无法序列化');
    ancestors.add(value);
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // 审计修复（Bug C）：'__proto__' 经 out[k]=v 赋值会触发 Object.prototype setter，
      // 键被静默丢弃（isDeepStrictEqual 自校验不比较原型，无法发现）——显式拒绝而非静默丢失。
      if (k === '__proto__') {
        throw makeError('ERR_YAML_SERIALIZE', '配置含 __proto__ 键，拒绝序列化');
      }
      if (v === undefined) continue;
      out[k] = stripUndefined(v, ancestors);
    }
    ancestors.delete(value);
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
  const YAML = require('yaml'); // 惰性依赖：仅本函数需要
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
