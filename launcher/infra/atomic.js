'use strict';
// infra/atomic.js — 原子写（tmp + rename + fsync）
//
// 审计修复：所有写盘走统一原子写 API（审计目标 4.2 原则 3），
// 失败不会留下半截文件；tmp 与目标同目录保证 rename 同文件系统。
// A2 修复：tmp 名不可预测（随机后缀）+ O_EXCL 独占创建（防符号链接预置劫持）；
// closeSync 异常不再遮蔽主错误；POSIX 下 rename 后尽力 fsync 父目录。
const path = require('path');
const crypto = require('crypto');
const { makeError } = require('../contracts/errors');

/**
 * 原子写文件。
 * @param {object} fsPort fs 端口
 * @param {string} filePath 目标路径
 * @param {string|Buffer} data 内容
 * @param {object} [opts]
 * @param {number} [opts.mode] 文件模式（默认 0o644）
 * @param {string} [opts.errorCode] 失败错误码（QA 修复：默认 ERR_INSTALL_FAILED，
 *   调用方应按语义传入，如 state 持久化传 ERR_LOCK_ACQUIRE；避免一律归日志）
 * @returns {{ok: boolean, filePath?: string, bytes?: number, error?: Error}}
 */
function writeFileAtomic(fsPort, filePath, data, opts = {}) {
  const dir = path.dirname(filePath);
  const rand = crypto.randomBytes(6).toString('hex');
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${rand}.tmp`);
  const errorCode = opts.errorCode || 'ERR_INSTALL_FAILED';
  const mode = opts.mode === undefined ? 0o644 : opts.mode;
  let fd = null;
  try {
    fsPort.mkdirSync(dir, { recursive: true });
    // A2 修复：'wx' = O_CREAT|O_EXCL|O_WRONLY——独占创建，拒绝预置符号链接/已存在文件
    fd = fsPort.openSync(tmp, 'wx', mode);
    try {
      fsPort.writeFileSync(fd, data, 'utf8');
      if (typeof fsPort.fsyncSync === 'function') fsPort.fsyncSync(fd);
    } catch (mainErr) {
      // A2 修复：主操作失败时，close 失败不得遮蔽主错误
      try { fsPort.closeSync(fd); } catch (_) { /* 忽略 */ }
      fd = null;
      throw mainErr;
    }
    // A2 修复：close 失败按写失败处理（此前 finally 中 closeSync 抛错会替换主错误）
    try {
      fsPort.closeSync(fd);
    } catch (closeErr) {
      fd = null;
      throw closeErr;
    }
    fd = null;
    fsPort.renameSync(tmp, filePath);
    // A2 修复（尽力而为）：POSIX 下 fsync 父目录，保证 rename 落盘；
    // 平台不支持（Windows）或端口无此能力时忽略——不影响主流程。
    try {
      const dirFd = fsPort.openSync(dir, 'r');
      try {
        if (typeof fsPort.fsyncSync === 'function') fsPort.fsyncSync(dirFd);
      } finally {
        try { fsPort.closeSync(dirFd); } catch (_) { /* 忽略 */ }
      }
    } catch (_) { /* 目录 fsync 不可用则跳过 */ }
    return { ok: true, filePath, bytes: Buffer.byteLength(data, 'utf8') };
  } catch (e) {
    try {
      if (fd !== null) { try { fsPort.closeSync(fd); } catch (_) { /* 忽略 */ } }
      if (fsPort.existsSync(tmp)) fsPort.unlinkSync(tmp);
    } catch (_) { /* 清理失败可忽略 */ }
    return { ok: false, error: makeError(errorCode, `原子写失败 ${filePath}：${e.message}`, { cause: e }) };
  }
}

module.exports = { writeFileAtomic };
