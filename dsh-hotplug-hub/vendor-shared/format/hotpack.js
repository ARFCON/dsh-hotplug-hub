'use strict';
// format/hotpack.js — 权威 hotpack 1.0 解析 + dshpack 桥接（R-v5-11，单一实现）
//
// 语义基线：launcher domain/assembly.js parseHotpack（严格顶层字段、保留名、
// semver 双检、源类型校验）；错误统一 {ok, code, message}（CLI 域）。
//
// opts：
//   - maxNameLength：插件 name 长度上限（hotplug 传 214 保持展示约束；
//     缺省不限制——launcher 语义）；
//   - maxDescLength：description 截断长度（hotplug 传 300；缺省不截断）；
//   - allowLegacy：缺省 true（launcher 兼容 {packId,bundles} 旧形态）；
//     hotplug 传 false（只接受 hotpack 1.0 显式形态）。
//
// hotplug 的 pack.memory:{keep:true} 由 hotplug 侧附加，不进本模块语义。
// 阶段 4 待办（H-11b/c）：dshpackToHotpack id 由显式 id 派生、npm 缺版本报错、产物复验。
const ids = require('../ids');
const { HOTPACK_VERSION } = require('../contracts/constants');

/**
 * 解析并校验 hotpack 1.0 输入（对象或 JSON 字符串）。
 * @param {unknown|string} input
 * @param {object} [opts]
 * @param {number} [opts.maxNameLength] 插件 name 长度上限（缺省不限）
 * @param {number} [opts.maxDescLength] description 截断长度（缺省不截断）
 * @param {boolean} [opts.allowLegacy] 是否接受 legacy {packId,bundles} 形态（默认 true）
 * @returns {{ok: boolean, pack?: object, code?: string, message?: string}}
 */
function parseHotpack(input, opts = {}) {
  let raw = input;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch (e) {
      return { ok: false, code: 'ERR_ASSEMBLY_INVALID_JSON', message: `assembly 不是合法 JSON：${e.message}` };
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'ERR_ASSEMBLY_FIELD', message: 'assembly 必须是 JSON 对象' };
  }
  if (raw.hotpack !== HOTPACK_VERSION) {
    // legacy 双格式兼容（旧 core.js 的 packId/bundles 形态，无 hotpack 字段）
    if (raw.hotpack === undefined && opts.allowLegacy !== false) return parseLegacy(raw, opts);
    return { ok: false, code: 'ERR_ASSEMBLY_UNSUPPORTED', message: `只支持 hotpack ${HOTPACK_VERSION}，实际 ${JSON.stringify(raw.hotpack)}` };
  }

  const idCheck = ids.validateId(raw.id);
  if (!idCheck.ok) return { ok: false, code: idCheck.error.code, message: idCheck.error.message };

  if (typeof raw.name !== 'string' || !raw.name.trim()) {
    return { ok: false, code: 'ERR_ASSEMBLY_FIELD', message: 'name 缺失' };
  }
  // C2 修复：产物 name 使用裁剪后的值（'  padded  ' 不再原样进入后续流程）
  const packName = raw.name.trim();
  const verCheck = ids.validateVersion(raw.version);
  if (!verCheck.ok) return { ok: false, code: verCheck.error.code, message: verCheck.error.message };

  if (!Array.isArray(raw.plugins) || raw.plugins.length === 0) {
    return { ok: false, code: 'ERR_ASSEMBLY_FIELD', message: 'plugins 必须是非空数组' };
  }

  const plugins = [];
  const seenIds = new Set();
  const seenNames = new Set();
  for (let i = 0; i < raw.plugins.length; i += 1) {
    const item = raw.plugins[i];
    const at = `plugins[${i}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, code: 'ERR_ASSEMBLY_FIELD', message: `${at} 必须是对象` };
    }
    const pidCheck = ids.validatePluginId(item.id);
    if (!pidCheck.ok) return { ok: false, code: pidCheck.error.code, message: `${at}.${pidCheck.error.message}` };
    const nameCheck = ids.validatePluginName(item.name);
    if (!nameCheck.ok) return { ok: false, code: nameCheck.error.code, message: `${at}.${nameCheck.error.message}` };
    if (opts.maxNameLength !== undefined && (typeof item.name !== 'string' || item.name.length > opts.maxNameLength)) {
      return { ok: false, code: 'ERR_ASSEMBLY_FIELD', message: `${at}.name 过长（>${opts.maxNameLength}）` };
    }

    const idKey = String(item.id).toLowerCase();
    if (seenIds.has(idKey)) {
      return { ok: false, code: 'ERR_ASSEMBLY_DUPLICATE', message: `${at}.id 重复（大小写不敏感）：${item.id}` };
    }
    seenIds.add(idKey);
    const nameKey = String(item.name).toLowerCase();
    if (seenNames.has(nameKey)) {
      return { ok: false, code: 'ERR_ASSEMBLY_DUPLICATE', message: `${at}.name 重复（大小写不敏感）：${item.name}` };
    }
    seenNames.add(nameKey);

    // C2 修复：source/config 显式存在但类型错误时拒绝，不再静默降级为默认值
    if (item.source !== undefined && item.source !== null &&
        (typeof item.source !== 'object' || Array.isArray(item.source))) {
      return { ok: false, code: 'ERR_ASSEMBLY_FIELD', message: `${at}.source 必须是对象` };
    }
    if (item.config !== undefined && item.config !== null &&
        (typeof item.config !== 'object' || Array.isArray(item.config))) {
      return { ok: false, code: 'ERR_ASSEMBLY_FIELD', message: `${at}.config 必须是对象` };
    }
    const source = item.source && typeof item.source === 'object' ? item.source : {};
    // C2/审计修复：source.type 显式为 ''（空串）时必须拒绝，不得与「缺省 npm」混同——
    // 此前 `source.type || 'npm'` 把空串与缺失都静默降级为 npm，与 `' '`（空白）被拒绝
    // 自相矛盾，且用户漏写 type 时 source.repo/source.path 被整段丢弃、插件被误当 npm 安装。
    const type = source.type === undefined || source.type === null ? 'npm' : source.type;
    if (type !== 'npm' && type !== 'path' && type !== 'github') {
      return { ok: false, code: 'ERR_ASSEMBLY_FIELD', message: `${at}.source.type 只支持 npm / path / github` };
    }

    const entry = { id: item.id, name: item.name, source: { type }, config: item.config && typeof item.config === 'object' ? item.config : {} };
    if (type === 'npm') {
      const vCheck = ids.validateVersion(item.version);
      if (!vCheck.ok) return { ok: false, code: vCheck.error.code, message: `${at} npm 源必须给精确 version：${vCheck.error.message}` };
      entry.version = item.version;
    } else if (type === 'path') {
      const pCheck = ids.validateSourcePath(source.path);
      if (!pCheck.ok) return { ok: false, code: pCheck.error.code, message: `${at}.${pCheck.error.message}` };
      entry.source.path = source.path;
    } else {
      const rCheck = ids.validateSourceRepo(source.repo);
      if (!rCheck.ok) return { ok: false, code: rCheck.error.code, message: `${at}.${rCheck.error.message}` };
      // C2 修复：ref 为可选字段，缺省 'main' 是文档化默认（不再伪装成"必填报错"）；
      // 仅当显式提供时才走严格校验。
      if (source.ref !== undefined) {
        const refCheck = ids.validateSourceRef(source.ref);
        if (!refCheck.ok) return { ok: false, code: refCheck.error.code, message: `${at}.${refCheck.error.message}` };
      }
      entry.source.repo = source.repo;
      entry.source.ref = source.ref || 'main';
    }
    plugins.push(entry);
  }

  const description = typeof raw.description === 'string'
    ? (opts.maxDescLength !== undefined ? raw.description.slice(0, opts.maxDescLength) : raw.description)
    : '';
  const pack = {
    hotpack: HOTPACK_VERSION,
    id: raw.id,
    name: packName,
    version: raw.version,
    description,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t) => typeof t === 'string') : [],
    plugins
  };
  return { ok: true, pack };
}

/**
 * legacy 装配解析：兼容旧 core.js 的 {packId, bundles} 形态（无 hotpack 字段）。
 * 显式校验拒绝静默造数（N38 修复）：缺 id/name/version/plugins 一律报错，不注入默认值。
 * @param {object} raw 已解析的 legacy 对象
 * @param {object} [opts] 透传 parseHotpack opts
 * @returns {{ok: boolean, pack?: object, code?: string, message?: string}}
 */
function parseLegacy(raw, opts = {}) {
  const id = typeof raw.id === 'string' ? raw.id : (typeof raw.packId === 'string' ? raw.packId : null);
  if (!id) {
    return { ok: false, code: 'ERR_ASSEMBLY_FIELD', message: 'legacy 装配缺少 id/packId' };
  }
  if (typeof raw.name !== 'string' || !raw.name.trim()) {
    return { ok: false, code: 'ERR_ASSEMBLY_FIELD', message: 'legacy 装配缺少 name（不再注入默认值）' };
  }
  if (typeof raw.version !== 'string' || !raw.version.trim()) {
    return { ok: false, code: 'ERR_ASSEMBLY_FIELD', message: 'legacy 装配缺少 version（不再注入 0.0.1）' };
  }
  const bundles = Array.isArray(raw.bundles) ? raw.bundles : (Array.isArray(raw.plugins) ? raw.plugins : null);
  if (!bundles || bundles.length === 0) {
    return { ok: false, code: 'ERR_ASSEMBLY_FIELD', message: 'legacy 装配 plugins/bundles 必须是非空数组' };
  }
  const plugins = [];
  for (let i = 0; i < bundles.length; i += 1) {
    const b = bundles[i];
    if (!b || typeof b !== 'object' || Array.isArray(b)) {
      return { ok: false, code: 'ERR_ASSEMBLY_FIELD', message: `legacy bundles[${i}] 必须是对象` };
    }
    const name = b.package || b.name;
    if (typeof name !== 'string' || !name.trim()) {
      return { ok: false, code: 'ERR_ASSEMBLY_FIELD', message: `legacy bundles[${i}] 缺少 package/name` };
    }
    // C2 修复（N38 精神）：bundle 缺 id 不再伪造 'p0'/'p1'（伪造 id 会与用户
    // 真实 id 碰撞并成为持久化身份，属静默造数），改为显式报错。
    if (typeof b.id !== 'string' || !b.id) {
      return { ok: false, code: 'ERR_ASSEMBLY_FIELD', message: `legacy bundles[${i}] 缺少 id（不再自动生成）` };
    }
    if (b.source !== undefined && b.source !== null &&
        (typeof b.source !== 'object' || Array.isArray(b.source))) {
      return { ok: false, code: 'ERR_ASSEMBLY_FIELD', message: `legacy bundles[${i}].source 必须是对象` };
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
  }, opts);
}

/**
 * validateAssembly 别名：语义化入口。
 * @param {unknown|string} input
 * @param {object} [opts]
 * @returns {{ok: boolean, pack?: object, code?: string, message?: string}}
 */
function validateAssembly(input, opts) {
  return parseHotpack(input, opts);
}

/**
 * .dshpack.json（规划格式）→ hotpack v1 转换。
 * H-11b/c 修复（v5 阶段 4）：
 *   - id 由显式 bundle.id 派生（存在且合法时优先；否则回退 role 清洗——与非 ASCII
 *     role 回退 pluginN 的既有语义一致）；显式 id 非法则报错（不静默造数）；
 *   - npm 源缺精确 version 显式报错（不再静默跳过 bundle）；
 *   - 产物经 parseHotpack 复验（权威校验器兜底）。
 * @param {string} text
 * @param {object} [opts]
 * @returns {{ok: boolean, pack?: object, code?: string, message?: string}}
 */
function dshpackToHotpack(text, opts = {}) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, code: 'ERR_ASSEMBLY_INVALID_JSON', message: '.dshpack.json 不是合法 JSON' };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'ERR_ASSEMBLY_FIELD', message: '.dshpack.json 必须是对象' };
  }
  const bundles = Array.isArray(raw.bundles) ? raw.bundles : [];
  if (bundles.length === 0) {
    return { ok: false, code: 'ERR_ASSEMBLY_FIELD', message: '.dshpack.json 必须含非空 bundles' };
  }
  const plugins = [];
  for (let index = 0; index < bundles.length; index += 1) {
    const bundle = bundles[index];
    if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) {
      return { ok: false, code: 'ERR_ASSEMBLY_FIELD', message: `bundles[${index}] 必须是对象` };
    }
    const name = bundle.package ?? bundle.name;
    if (typeof name !== 'string' || name.length === 0) {
      return { ok: false, code: 'ERR_ASSEMBLY_FIELD', message: `bundles[${index}] 缺少 package/name` };
    }
    // 审计修复：source 显式枚举 npm/github，未知类型（如 'path'）显式报错，不再静默降级
    // 为 npm（此前 `=== 'github' ? 'github' : 'npm'` 把 source:'path' / {type:'path'} 的
    // path 信息整段丢弃、插件被误当 npm 包，或报出误导性「npm 源必须给精确 version」）。
    const sourceRaw = bundle.source;
    const sourceTypeRaw = sourceRaw && typeof sourceRaw === 'object' ? sourceRaw.type : sourceRaw;
    const sourceType = sourceTypeRaw === undefined || sourceTypeRaw === null ? 'npm' : sourceTypeRaw;
    if (sourceType !== 'npm' && sourceType !== 'github') {
      return { ok: false, code: 'ERR_ASSEMBLY_FIELD', message: `bundles[${index}]（${name}）source 只支持 npm / github：${JSON.stringify(sourceType)}` };
    }
    const version = bundle.version;
    if (sourceType === 'npm' && (typeof version !== 'string' || version.length === 0)) {
      // H-11b：npm 源缺精确 version 显式报错（曾静默跳过该 bundle）
      return { ok: false, code: 'ERR_ASSEMBLY_FIELD', message: `bundles[${index}]（${name}）npm 源必须给精确 version` };
    }
    // H-11b：id 由显式 bundle.id 派生（合法时优先；非法报错不静默造数）
    let id = null;
    if (typeof bundle.id === 'string' && bundle.id !== '') {
      if (!/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(bundle.id)) {
        return { ok: false, code: 'ERR_ASSEMBLY_FIELD', message: `bundles[${index}].id 非法：${JSON.stringify(bundle.id)}` };
      }
      id = bundle.id;
    } else {
      const role = typeof bundle.role === 'string' && bundle.role !== '' ? bundle.role : 'plugin' + (index + 1);
      // 审计修复：派生 id 须保证首字符字母数字（validatePluginId 要求 /^[a-z0-9]/）。
      // 此前 role='_foo' 派生 '_foo'（前导下划线未剥）被 parseHotpack 以「插件 id 非法」
      // 拒绝，报错与「role 派生」意图脱节。现先剥前导下划线再剥首尾连字符。
      id = role.toLowerCase()
        .replace(/[^a-z0-9_]+/g, '-')
        .replace(/^_+/, '')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'plugin' + (index + 1);
    }
    const source = { type: sourceType };
    if (sourceType === 'github') {
      if (bundle.source && typeof bundle.source === 'object') {
        source.repo = typeof bundle.source.repo === 'string' ? bundle.source.repo : undefined;
        source.ref = typeof bundle.source.ref === 'string' ? bundle.source.ref : 'main';
      }
      if (source.repo === undefined) {
        return { ok: false, code: 'ERR_ASSEMBLY_FIELD', message: `bundles[${index}]（${name}）github 源必须给 source.repo` };
      }
    }
    plugins.push({ id, name, version, source });
  }
  return parseHotpack(JSON.stringify({
    hotpack: '1.0',
    id: raw.packId ?? raw.id,
    name: raw.name,
    version: raw.version,
    description: raw.description ?? '',
    tags: raw.tags ?? [],
    plugins
  }), opts);
}

module.exports = { parseHotpack, parseLegacy, validateAssembly, dshpackToHotpack };
