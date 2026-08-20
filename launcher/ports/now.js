'use strict';
// ports/now.js — 时钟端口接口（让 Domain 保持零副作用；时间全部注入）
const { makeError } = require('../contracts/errors');

const NOW_METHODS = ['now', 'iso'];

/**
 * 构造"未注入"错误。
 * @param {string} name
 * @returns {Error}
 */
function notInjected(name) {
  return makeError('ERR_ENV_UNSUPPORTED', `端口未注入：now.${name}（请在 createCore 时提供 nowPort）`);
}

/**
 * 创建时钟端口。
 * @param {object} [impl]
 * @param {Function} [impl.now] () => number 毫秒时间戳
 * @param {Function} [impl.iso] (t?) => string ISO 时间字符串
 * @returns {object}
 */
function createNowPort(impl = {}) {
  const port = {};
  for (const m of NOW_METHODS) {
    port[m] = typeof impl[m] === 'function' ? impl[m].bind(impl) : () => { throw notInjected(m); };
  }
  return port;
}

/**
 * 真实时钟端口。
 * @returns {object}
 */
function createSystemNowPort() {
  return createNowPort({
    now: () => Date.now(),
    iso: (t) => new Date(t === undefined ? Date.now() : t).toISOString()
  });
}

const defaultNowPort = createSystemNowPort();

module.exports = { createNowPort, createSystemNowPort, defaultNowPort, NOW_METHODS };
