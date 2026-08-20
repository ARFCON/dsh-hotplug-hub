'use strict';
// domain/manifest.js — 生成 sandbox package.json manifest（纯函数，零副作用）
//
// 审计修复：
//   - B：npm 源进 dependencies（不再空 dependencies）
//   - E：只用真实契约字段 dsh.bundle.patch 决定 dsh.profile.bundles（弃用 bundlePatch）
//   - N42：manifest.name 由已校验的 pack.id 派生，杜绝 `../` 注入
// C3 修复：
//   - dependencies 版本前缀防护：仅对精确版本加 '^'；已是范围/tag 的按原样；
//     非法版本回落 'latest'（杜绝 ^^1.0.0 / ^latest 等非法 npm spec）；
//   - github 源依赖改为相对 link:./node_modules/<name>——此前指向
//     storeRoot/<name>@<ref>（从未被安装器填充的目录），与 install 实际落地
//     （profile/node_modules/<name>）对齐。
const path = require('path');
const semver = require('semver');

/**
 * 构建 sandbox manifest。
 * @param {object} pack parseHotpack 产物
 * @param {Array<object>} plugins resolved 插件
 * @param {string} storeRoot 本地 store 根
 * @returns {object} manifest
 */
function buildManifest(pack, plugins, storeRoot) {
  const dependencies = {};
  const bundles = [];
  for (const p of plugins) {
    if (p.source.type === 'npm') {
      const ver = p.resolvedVersion || p.version;
      dependencies[p.name] = versionSpec(ver);
    } else if (p.source.type === 'path') {
      dependencies[p.name] = `link:${String(p.installPath).replace(/\\/g, '/')}`;
    } else {
      // C3 修复：github 源依赖指向安装器实际落地位置（profile/node_modules/<name>），
      // 而非从未被填充的 storeRoot/<name>@<ref>。
      dependencies[p.name] = `link:./node_modules/${p.name}`;
    }
    // E 修复：真实字段 dsh.bundle.patch 才进 bundles
    if (p.config && p.config['dsh.bundle.patch'] === true && !bundles.includes(p.name)) {
      bundles.push(p.name);
    }
  }
  return {
    name: `dsh-launcher-${pack.id}`,
    version: '0.1.0',
    private: true,
    dependencies,
    dsh: { profile: { bundles } }
  };
}

/**
 * 生成 npm 依赖版本 spec（C3 修复：无防护的 `^${ver}` 会产生 ^^1.0.0、^latest
 * 等非法 spec）。
 * @param {string|undefined|null} ver
 * @returns {string}
 */
function versionSpec(ver) {
  if (typeof ver !== 'string' || ver.length === 0) return 'latest';
  if (semver.valid(ver)) return `^${ver}`;          // 精确版 → 兼容范围
  if (semver.validRange(ver)) return ver;           // 已是范围（^1.0.0/>=1.0.0/1.x）
  if (/^(latest|next|beta|alpha|rc)$/.test(ver)) return ver; // 已知 tag 原样
  return 'latest';                                   // 非法串 → 兜底 latest
}

module.exports = { buildManifest, versionSpec };
