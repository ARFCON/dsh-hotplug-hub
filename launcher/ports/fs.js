'use strict';
// ports/fs.js — 文件系统端口接口（JSDoc 契约；未注入时抛"端口未注入"）
//
// 设计：ports 层只定义接口与工厂；副作用实现由 infra/app 注入。
const { makeError } = require('../contracts/errors');

const FS_METHODS = [
  'readFileSync', 'writeFileSync', 'appendFileSync', 'existsSync',
  'mkdirSync', 'rmdirSync', 'copyFileSync', 'renameSync', 'readdirSync', 'statSync',
  'lstatSync', 'readSync', 'writeSync', 'ftruncateSync', 'unlinkSync', 'rmSync', 'openSync', 'closeSync', 'fsyncSync',
  'symlinkSync', 'realpathSync',
  'createReadStream', 'createWriteStream', 'readFile', 'appendFile'
];

/**
 * 构造"未注入"错误。
 * @param {string} name
 * @returns {Error}
 */
function notInjected(name) {
  return makeError('ERR_ENV_UNSUPPORTED', `端口未注入：fs.${name}（请在 createCore 时提供 fsPort）`);
}

/**
 * 创建 fs 端口。未提供的每个方法都会抛"端口未注入"。
 * @param {object} [impl] 方法实现（通常直接传 node:fs）
 * @returns {object}
 */
function createFsPort(impl = {}) {
  const port = {};
  for (const m of FS_METHODS) {
    port[m] = typeof impl[m] === 'function' ? impl[m].bind(impl) : () => { throw notInjected(m); };
  }
  return port;
}

const defaultFsPort = createFsPort();

module.exports = { createFsPort, defaultFsPort, FS_METHODS };
