'use strict';
// domain/resolve.js — 依赖解析 + semver 版本 pin（纯函数，registry 可注入）
//
// 审计修复：B（npm 源必须进入 resolved 并 pin 版本）/ G（resolved 被消费）
const semver = require('semver');
const { EXACT_VERSION_RE } = require('../contracts/constants');
const { makeError } = require('../contracts/errors');

/**
 * 是否为精确版本号（C2 修复：正则 + semver.valid 双条件，与 ids.validateVersion 一致）。
 * @param {unknown} v
 * @returns {boolean}
 */
function isExactVersion(v) {
  return typeof v === 'string' && EXACT_VERSION_RE.test(v) && semver.valid(v) !== null;
}

/**
 * 解析单个 npm 插件版本：精确版直接 pin；范围版查询 registry 选最高满足。
 * @param {string} name
 * @param {string|undefined} version
 * @param {object} [registry] 可注入 { availableVersions(name) -> string[] }
 * @returns {{resolvedVersion: string|null, pinned: boolean, source: string, warning?: string, error?: Error}}
 */
function resolveVersion(name, version, registry) {
  let available = [];
  if (registry && typeof registry.availableVersions === 'function') {
    try {
      const got = registry.availableVersions(name);
      if (Array.isArray(got)) available = got;
    } catch (e) {
      // C2 修复：registry 端口异常不得冒泡 FATAL——按"无 registry 数据"处理并附 warning
      return {
        resolvedVersion: null,
        pinned: false,
        source: 'unresolved',
        warning: `registry 查询失败，无法 pin ${name}：${e.message}`
      };
    }
  }

  if (isExactVersion(version)) {
    return { resolvedVersion: version, pinned: true, source: 'exact' };
  }
  if (Array.isArray(available) && available.length > 0) {
    const range = version && semver.validRange(version) ? version : '*';
    let best = semver.maxSatisfying(available, range);
    let source = 'registry';
    if (!best) {
      // C2 修复（QA4 实证修正）：includePrerelease 对"候选仅含预发布版本"场景
      // 实际无效——semver.maxSatisfying(..., {includePrerelease:true}) 在候选
      // 无同元组正式版时仍返回 null（实测：['1.0.0-beta.2'] + '^1.0.0' → null）。
      // 按注释声称的语义（beta 期插件可解析）手写元组宽松匹配：
      // 候选的主.次.补丁元组满足 range 即视为可接受，取其中最高版本。
      // 与 npm 严格语义的差异如实记录：range 未含预发布标识时也允许预发布候选。
      const tupleMatches = available.filter((v) => {
        const valid = semver.valid(v);
        if (!valid) return false;
        const tuple = valid.replace(/-.*$/, '');
        return semver.satisfies(tuple, range);
      });
      if (tupleMatches.length > 0) {
        best = tupleMatches.sort(semver.rcompare)[0];
        source = 'registry-prerelease';
      }
    }
    if (best) return { resolvedVersion: best, pinned: true, source };
    return {
      resolvedVersion: null,
      pinned: false,
      source: 'unresolved',
      error: makeError('ERR_INSTALL_ACQUIRE', `registry 中没有满足 ${name}@${range} 的版本`)
    };
  }
  if (version && semver.validRange(version)) {
    return {
      resolvedVersion: null,
      pinned: false,
      source: 'unresolved',
      warning: `无 registry 数据，无法 pin ${name}@${version}`
    };
  }
  // C2 修复：既非精确版也非合法范围的垃圾版本串（'garbage'/'latest' 等）——
  // 不得标 pinned:true source:'exact'（曾导致 install 把垃圾 spec 交给 npm、
  // conflicts 将其按"缺版本"处理），改为 unresolved + warning。
  if (typeof version === 'string' && version.length > 0) {
    return {
      resolvedVersion: null,
      pinned: false,
      source: 'unresolved',
      warning: `非法版本串，无法 pin ${name}@${version}`
    };
  }
  return { resolvedVersion: null, pinned: false, source: 'unresolved', warning: `缺少版本，无法 pin ${name}` };
}

/**
 * 解析整个 pack：为每个插件产出 resolved 记录。
 * @param {object} pack parseHotpack 产物
 * @param {object} [registry] 可注入 registry 端口
 * @returns {{ok: boolean, resolved?: object, warnings?: Array<object>, error?: Error}}
 */
function resolvePlugins(pack, registry) {
  const warnings = [];
  const plugins = [];
  for (const p of pack.plugins) {
    const base = { id: p.id, name: p.name, source: p.source, config: p.config || {} };
    if (p.source.type === 'npm') {
      const r = resolveVersion(p.name, p.version, registry);
      if (r.error) return { ok: false, error: r.error };
      if (r.warning) warnings.push({ plugin: p.name, warning: r.warning });
      plugins.push({
        ...base,
        version: p.version || null,
        resolvedVersion: r.resolvedVersion,
        pinned: r.pinned,
        installPath: null,
        ref: null
      });
    } else if (p.source.type === 'path') {
      plugins.push({
        ...base,
        version: null,
        resolvedVersion: null,
        pinned: false,
        installPath: p.source.path,
        ref: null
      });
    } else {
      // github
      plugins.push({
        ...base,
        version: p.version || p.source.ref || null,
        resolvedVersion: p.source.ref || 'main',
        pinned: false,
        installPath: null,
        ref: p.source.ref || 'main'
      });
    }
  }
  return {
    ok: true,
    resolved: { plugins, conflicts: [], pinnedAt: null },
    warnings
  };
}

module.exports = { isExactVersion, resolveVersion, resolvePlugins };
