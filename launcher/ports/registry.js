'use strict';
// ports/registry.js — npm registry 端口接口（可注入，供 resolve 做 semver pin）
const { makeError } = require('../contracts/errors');

const REGISTRY_METHODS = ['availableVersions', 'resolveBest'];

/**
 * 构造"未注入"错误。
 * @param {string} name
 * @returns {Error}
 */
function notInjected(name) {
  return makeError('ERR_ENV_UNSUPPORTED', `端口未注入：registry.${name}（请在 createCore 时提供 registryPort）`);
}

/**
 * 创建 registry 端口。
 * @param {object} [impl]
 * @param {Function} [impl.availableVersions] (name) => string[] 包名到可用版本列表
 * @param {Function} [impl.resolveBest] (name, range) => string|null 解析最高满足版本
 * @returns {object}
 */
function createRegistryPort(impl = {}) {
  const port = {};
  for (const m of REGISTRY_METHODS) {
    port[m] = typeof impl[m] === 'function' ? impl[m].bind(impl) : () => { throw notInjected(m); };
  }
  return port;
}

/**
 * 空 registry：不联网，返回空版本列表（resolve 会给出 warning 而非失败）。
 * @returns {object}
 */
function createEmptyRegistryPort() {
  return createRegistryPort({
    availableVersions: () => [],
    resolveBest: () => null
  });
}

const defaultRegistryPort = createEmptyRegistryPort();

module.exports = { createRegistryPort, createEmptyRegistryPort, defaultRegistryPort, REGISTRY_METHODS };
