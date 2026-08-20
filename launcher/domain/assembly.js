'use strict';
// domain/assembly.js — 读取 + 校验 assembly（hotpack 1.0，纯函数，零副作用）
//
// 审计修复：
//   - K/N14：插件 id 唯一性校验（大小写不敏感）
//   - N7：JSON 语法错误与"找不到 assembly"区分（错误码不同）
//   - N21/N22：空 plugins 与未知 source.type 拒绝
//   - N35：source.path / source.repo 校验
const { HOTPACK_VERSION } = require('../contracts/constants');
const { makeError } = require('../contracts/errors');
const ids = require('./ids');

/**
 * 解析并校验 hotpack 1.0 输入（对象或 JSON 字符串）。
 * @param {unknown|string} input
 * @returns {{ok: boolean, pack?: object, error?: Error}}
 */
function parseHotpack(input) {
  let raw = input;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch (e) {
      return { ok: false, error: makeError('ERR_ASSEMBLY_INVALID_JSON', `assembly 不是合法 JSON：${e.message}`) };
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: makeError('ERR_ASSEMBLY_FIELD', 'assembly 必须是 JSON 对象') };
  }
  if (raw.hotpack !== HOTPACK_VERSION) {
    // FIX-6：legacy 双格式兼容（旧 core.js:71-79 的 packId/bundles 形态，无 hotpack 字段）
    if (raw.hotpack === undefined) return parseLegacy(raw);
    return { ok: false, error: makeError('ERR_ASSEMBLY_UNSUPPORTED', `只支持 hotpack ${HOTPACK_VERSION}，实际 ${JSON.stringify(raw.hotpack)}`) };
  }

  const idCheck = ids.validateId(raw.id);
  if (!idCheck.ok) return { ok: false, error: idCheck.error };

  if (typeof raw.name !== 'string' || !raw.name.trim()) {
    return { ok: false, error: makeError('ERR_ASSEMBLY_FIELD', 'name 缺失') };
  }
  // C2 修复：产物 name 使用裁剪后的值（'  padded  ' 不再原样进入后续流程）
  const packName = raw.name.trim();
  const verCheck = ids.validateVersion(raw.version);
  if (!verCheck.ok) return { ok: false, error: verCheck.error };

  if (!Array.isArray(raw.plugins) || raw.plugins.length === 0) {
    return { ok: false, error: makeError('ERR_ASSEMBLY_FIELD', 'plugins 必须是非空数组') };
  }

  const plugins = [];
  const seenIds = new Set();
  const seenNames = new Set();
  for (let i = 0; i < raw.plugins.length; i += 1) {
    const item = raw.plugins[i];
    const at = `plugins[${i}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, error: makeError('ERR_ASSEMBLY_FIELD', `${at} 必须是对象`) };
    }
    const pidCheck = ids.validatePluginId(item.id);
    if (!pidCheck.ok) return { ok: false, error: makeError(pidCheck.error.code, `${at}.${pidCheck.error.message}`) };
    const nameCheck = ids.validatePluginName(item.name);
    if (!nameCheck.ok) return { ok: false, error: makeError(nameCheck.error.code, `${at}.${nameCheck.error.message}`) };

    const idKey = String(item.id).toLowerCase();
    if (seenIds.has(idKey)) {
      return { ok: false, error: makeError('ERR_ASSEMBLY_DUPLICATE', `${at}.id 重复（大小写不敏感）：${item.id}`) };
    }
    seenIds.add(idKey);
    const nameKey = String(item.name).toLowerCase();
    if (seenNames.has(nameKey)) {
      return { ok: false, error: makeError('ERR_ASSEMBLY_DUPLICATE', `${at}.name 重复（大小写不敏感）：${item.name}`) };
    }
    seenNames.add(nameKey);

    // C2 修复：source/config 显式存在但类型错误时拒绝，不再静默降级为默认值
    // （source:'github' 字符串曾静默当作 npm 源、config 字符串被丢弃）。
    if (item.source !== undefined && item.source !== null &&
        (typeof item.source !== 'object' || Array.isArray(item.source))) {
      return { ok: false, error: makeError('ERR_ASSEMBLY_FIELD', `${at}.source 必须是对象`) };
    }
    if (item.config !== undefined && item.config !== null &&
        (typeof item.config !== 'object' || Array.isArray(item.config))) {
      return { ok: false, error: makeError('ERR_ASSEMBLY_FIELD', `${at}.config 必须是对象`) };
    }
    const source = item.source && typeof item.source === 'object' ? item.source : {};
    const type = source.type || 'npm';
    if (type !== 'npm' && type !== 'path' && type !== 'github') {
      return { ok: false, error: makeError('ERR_ASSEMBLY_FIELD', `${at}.source.type 只支持 npm / path / github`) };
    }

    const entry = { id: item.id, name: item.name, source: { type }, config: item.config && typeof item.config === 'object' ? item.config : {} };
    if (type === 'npm') {
      const vCheck = ids.validateVersion(item.version);
      if (!vCheck.ok) return { ok: false, error: makeError(vCheck.error.code, `${at} npm 源必须给精确 version：${vCheck.error.message}`) };
      entry.version = item.version;
    } else if (type === 'path') {
      const pCheck = ids.validateSourcePath(source.path);
      if (!pCheck.ok) return { ok: false, error: makeError(pCheck.error.code, `${at}.${pCheck.error.message}`) };
      entry.source.path = source.path;
    } else {
      const rCheck = ids.validateSourceRepo(source.repo);
      if (!rCheck.ok) return { ok: false, error: makeError(rCheck.error.code, `${at}.${rCheck.error.message}`) };
      // C2 修复：ref 为可选字段，缺省 'main' 是文档化默认（不再伪装成"必填报错"）；
      // 仅当显式提供时才走严格校验。
      if (source.ref !== undefined) {
        const refCheck = ids.validateSourceRef(source.ref);
        if (!refCheck.ok) return { ok: false, error: makeError(refCheck.error.code, `${at}.${refCheck.error.message}`) };
      }
      entry.source.repo = source.repo;
      entry.source.ref = source.ref || 'main';
    }
    plugins.push(entry);
  }

  const pack = {
    hotpack: HOTPACK_VERSION,
    id: raw.id,
    name: packName,
    version: raw.version,
    description: typeof raw.description === 'string' ? raw.description : '',
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t) => typeof t === 'string') : [],
    plugins
  };
  return { ok: true, pack };
}

/**
 * legacy 装配解析：兼容旧 core.js 的 {packId, bundles} 形态（无 hotpack 字段）。
 * 显式校验拒绝静默造数（N38 修复）：缺 id/name/version/plugins 一律报错，不注入默认值。
 * @param {object} raw 已解析的 legacy 对象
 * @returns {{ok: boolean, pack?: object, error?: Error}}
 */
function parseLegacy(raw) {
  const id = typeof raw.id === 'string' ? raw.id : (typeof raw.packId === 'string' ? raw.packId : null);
  if (!id) {
    return { ok: false, error: makeError('ERR_ASSEMBLY_FIELD', 'legacy 装配缺少 id/packId') };
  }
  if (typeof raw.name !== 'string' || !raw.name.trim()) {
    return { ok: false, error: makeError('ERR_ASSEMBLY_FIELD', 'legacy 装配缺少 name（不再注入默认值）') };
  }
  if (typeof raw.version !== 'string' || !raw.version.trim()) {
    return { ok: false, error: makeError('ERR_ASSEMBLY_FIELD', 'legacy 装配缺少 version（不再注入 0.0.1）') };
  }
  const bundles = Array.isArray(raw.bundles) ? raw.bundles : (Array.isArray(raw.plugins) ? raw.plugins : null);
  if (!bundles || bundles.length === 0) {
    return { ok: false, error: makeError('ERR_ASSEMBLY_FIELD', 'legacy 装配 plugins/bundles 必须是非空数组') };
  }
  const plugins = [];
  for (let i = 0; i < bundles.length; i += 1) {
    const b = bundles[i];
    if (!b || typeof b !== 'object' || Array.isArray(b)) {
      return { ok: false, error: makeError('ERR_ASSEMBLY_FIELD', `legacy bundles[${i}] 必须是对象`) };
    }
    const name = b.package || b.name;
    if (typeof name !== 'string' || !name.trim()) {
      return { ok: false, error: makeError('ERR_ASSEMBLY_FIELD', `legacy bundles[${i}] 缺少 package/name`) };
    }
    // C2 修复（N38 精神）：bundle 缺 id 不再伪造 'p0'/'p1'（伪造 id 会与用户
    // 真实 id 碰撞并成为持久化身份，属静默造数），改为显式报错。
    if (typeof b.id !== 'string' || !b.id) {
      return { ok: false, error: makeError('ERR_ASSEMBLY_FIELD', `legacy bundles[${i}] 缺少 id（不再自动生成）`) };
    }
    if (b.source !== undefined && b.source !== null &&
        (typeof b.source !== 'object' || Array.isArray(b.source))) {
      return { ok: false, error: makeError('ERR_ASSEMBLY_FIELD', `legacy bundles[${i}].source 必须是对象`) };
    }
    const item = {
      id: b.id,
      name,
      source: b.source && typeof b.source === 'object' ? b.source : { type: 'npm' },
      config: b.config && typeof b.config === 'object' ? b.config : {}
    };
    if (item.source.type === 'npm' && typeof b.version === 'string') item.version = b.version;
    else if (b.version !== undefined) item.version = b.version;
    plugins.push(item);
  }
  return parseHotpack({
    hotpack: HOTPACK_VERSION,
    id,
    name: raw.name,
    version: raw.version,
    description: typeof raw.description === 'string' ? raw.description : '',
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t) => typeof t === 'string') : [],
    plugins
  });
}

/**
 * validateAssembly 别名：语义化入口。
 * @param {unknown|string} input
 * @returns {{ok: boolean, pack?: object, error?: Error}}
 */
function validateAssembly(input) {
  return parseHotpack(input);
}

module.exports = { parseHotpack, validateAssembly, parseLegacy };
