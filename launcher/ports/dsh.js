'use strict';
// ports/dsh.js — DSH harness 端口接口（探测 / 插件安装 / 完整性校验）
const { makeError } = require('../contracts/errors');

const DSH_METHODS = ['findHarness', 'verifyHarness', 'pluginAdd', 'isInstalled'];

/**
 * 构造"未注入"错误。
 * @param {string} name
 * @returns {Error}
 */
function notInjected(name) {
  return makeError('ERR_ENV_UNSUPPORTED', `端口未注入：dsh.${name}（请在 createCore 时提供 dshPort）`);
}

/**
 * 创建 dsh 端口。
 * @param {object} [impl]
 * @param {Function} [impl.findHarness] (opts) => {ok, harness?, error?} 探测官方 harness
 * @param {Function} [impl.verifyHarness] (file, opts) => {ok, error?} 完整性校验（N44 修复）
 * @param {Function} [impl.pluginAdd] (profile, name, version) => Promise<{ok, error?}> dsh plugin add 通道
 * @param {Function} [impl.isInstalled] (profile, name) => boolean 是否已安装
 * @returns {object}
 */
function createDshPort(impl = {}) {
  const port = {};
  for (const m of DSH_METHODS) {
    port[m] = typeof impl[m] === 'function' ? impl[m].bind(impl) : () => { throw notInjected(m); };
  }
  return port;
}

const defaultDshPort = createDshPort();

module.exports = { createDshPort, defaultDshPort, DSH_METHODS };
