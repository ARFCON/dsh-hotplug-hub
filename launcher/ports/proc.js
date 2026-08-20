'use strict';
// ports/proc.js — 子进程端口接口（spawn / spawnSync）
const { makeError } = require('../contracts/errors');

const PROC_METHODS = ['spawn', 'spawnSync'];

/**
 * 构造"未注入"错误。
 * @param {string} name
 * @returns {Error}
 */
function notInjected(name) {
  return makeError('ERR_ENV_UNSUPPORTED', `端口未注入：proc.${name}（请在 createCore 时提供 procPort）`);
}

/**
 * 创建 proc 端口。未提供的每个方法都会抛"端口未注入"。
 * @param {object} [impl] 方法实现（通常传 node:child_process 的 spawn/spawnSync）
 * @returns {object}
 */
function createProcPort(impl = {}) {
  const port = {};
  for (const m of PROC_METHODS) {
    port[m] = typeof impl[m] === 'function' ? impl[m].bind(impl) : () => { throw notInjected(m); };
  }
  return port;
}

const defaultProcPort = createProcPort();

module.exports = { createProcPort, defaultProcPort, PROC_METHODS };
