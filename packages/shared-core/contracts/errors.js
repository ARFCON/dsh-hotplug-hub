'use strict';
// contracts/errors.js — CLI 域错误码（32 码）与退出码映射（0-12）
//
// 退出码约定：
//   2=参数/安全  3=装配  4=冲突  5=YAML  6=安装  7=harness
//   8=启动  9=自愈  10=状态锁  11=日志  12=环境
//
// 消费模型（v5 契约 §5.1）：
//   - CLI 域（launcher / hotplug 网关）统一 makeError + isDshError + exitCodeForCode；
//   - memory 域保留类型化 MemoryHubError（语义码），不强行并入 ERR_*；
//   - 跨域边界仅映射 {code, message}，不吞并语义。
//
// 阶段 2 待办（M-37）：makeError 校验 code 必须在 ERROR_CODES 声明内（见 CONTRACT.md）。

const ERROR_CODES = {
  // --- 参数 / 安全（退出码 2）---
  ERR_ARG_INVALID_ID: 'ERR_ARG_INVALID_ID',
  ERR_ARG_PATH_ESCAPE: 'ERR_ARG_PATH_ESCAPE',
  ERR_ARG_MISSING_ARG: 'ERR_ARG_MISSING_ARG',
  ERR_ARG_UNKNOWN_COMMAND: 'ERR_ARG_UNKNOWN_COMMAND',
  ERR_ARG_BAD_OPTION: 'ERR_ARG_BAD_OPTION',
  // M-36 修复（v5 阶段 2）：非法状态转移专属错误码（原复用 ERR_ENV_UNSUPPORTED/exit12 误导）
  ERR_ARG_BAD_STATE: 'ERR_ARG_BAD_STATE',
  // --- 装配（退出码 3）---
  ERR_ASSEMBLY_NOT_FOUND: 'ERR_ASSEMBLY_NOT_FOUND',
  ERR_ASSEMBLY_INVALID_JSON: 'ERR_ASSEMBLY_INVALID_JSON',
  ERR_ASSEMBLY_UNSUPPORTED: 'ERR_ASSEMBLY_UNSUPPORTED',
  ERR_ASSEMBLY_FIELD: 'ERR_ASSEMBLY_FIELD',
  ERR_ASSEMBLY_DUPLICATE: 'ERR_ASSEMBLY_DUPLICATE',
  // --- 冲突（退出码 4）---
  ERR_CONFLICT_VERSION: 'ERR_CONFLICT_VERSION',
  ERR_CONFLICT_ROLE: 'ERR_CONFLICT_ROLE',
  ERR_CONFLICT_DEPENDENCY: 'ERR_CONFLICT_DEPENDENCY',
  ERR_CONFLICT_BLOCKED: 'ERR_CONFLICT_BLOCKED',
  // --- YAML（退出码 5）---
  ERR_YAML_SERIALIZE: 'ERR_YAML_SERIALIZE',
  ERR_YAML_PARSE: 'ERR_YAML_PARSE',
  ERR_YAML_INVALID: 'ERR_YAML_INVALID',
  // --- 安装（退出码 6）---
  ERR_INSTALL_FAILED: 'ERR_INSTALL_FAILED',
  ERR_INSTALL_DEP: 'ERR_INSTALL_DEP',
  ERR_INSTALL_ACQUIRE: 'ERR_INSTALL_ACQUIRE',
  // --- harness（退出码 7）---
  ERR_HARNESS_NOT_FOUND: 'ERR_HARNESS_NOT_FOUND',
  ERR_HARNESS_UNTRUSTED: 'ERR_HARNESS_UNTRUSTED',
  // --- 启动（退出码 8）---
  ERR_LAUNCH_SPAWN: 'ERR_LAUNCH_SPAWN',
  ERR_LAUNCH_EXIT: 'ERR_LAUNCH_EXIT',
  ERR_LAUNCH_TIMEOUT: 'ERR_LAUNCH_TIMEOUT',
  ERR_LAUNCH_DETACH: 'ERR_LAUNCH_DETACH',
  // --- 自愈（退出码 9）---
  ERR_HEAL_NO_ACTION: 'ERR_HEAL_NO_ACTION',
  ERR_HEAL_BUDGET: 'ERR_HEAL_BUDGET',
  ERR_HEAL_ROLLBACK: 'ERR_HEAL_ROLLBACK',
  // --- 状态锁（退出码 10）---
  ERR_LOCK_ACQUIRE: 'ERR_LOCK_ACQUIRE',
  // --- 日志（退出码 11）---
  ERR_LOG_WRITE: 'ERR_LOG_WRITE',
  // --- 环境（退出码 12）---
  ERR_ENV_UNSUPPORTED: 'ERR_ENV_UNSUPPORTED'
};

// 按错误码前缀推导退出码
const EXIT_CODE_BY_PREFIX = {
  ERR_ARG_: 2,
  ERR_ASSEMBLY_: 3,
  ERR_CONFLICT_: 4,
  ERR_YAML_: 5,
  ERR_INSTALL_: 6,
  ERR_HARNESS_: 7,
  ERR_LAUNCH_: 8,
  ERR_HEAL_: 9,
  ERR_LOCK_: 10,
  ERR_LOG_: 11,
  ERR_ENV_: 12
};

/**
 * 由错误码计算进程退出码。
 * @param {string|null|undefined} code
 * @returns {number}
 */
function exitCodeForCode(code) {
  if (!code || typeof code !== 'string') return 1;
  for (const prefix of Object.keys(EXIT_CODE_BY_PREFIX)) {
    if (code.startsWith(prefix)) return EXIT_CODE_BY_PREFIX[prefix];
  }
  return 1;
}

/**
 * 构造带 code/exitCode 的 DshError。
 *
 * 契约保证：err.exitCode 只由 code 推导（退出码 0-12），
 * 调用方 extra 中携带的 exitCode 一律忽略（QA Bug #1 修复：
 * ERR_LAUNCH_EXIT 曾被子进程真实退出码覆盖为 1，破坏统一契约）。
 * 如需携带子进程退出码，请用 childExitCode 等独立字段。
 *
 * M-37 修复（v5 阶段 2）：code 必须在 ERROR_CODES 声明内，否则抛 TypeError——
 * 杜绝"声明外 code 静默通过"造成的退出码/错误域错位。
 *
 * @param {string} code 错误码（见 ERROR_CODES）
 * @param {string} message 人类可读消息
 * @param {object} [extra] 附加字段（cause/childExitCode 等；exitCode 被忽略）
 * @returns {Error}
 */
function makeError(code, message, extra = {}) {
  // M-37：声明内校验（未知 code 直接抛错——调用方 bug，不应静默进入契约外形态）
  if (typeof code !== 'string' || !Object.prototype.hasOwnProperty.call(ERROR_CODES, code)) {
    throw new TypeError(`makeError 收到未声明的错误码：${JSON.stringify(code)}（必须在 ERROR_CODES 内）`);
  }
  const err = new Error(message);
  err.code = code;
  err.exitCode = exitCodeForCode(code);
  // 剔除 extra 中的保留字段，防止覆盖契约退出码（C1 修复：code/message 也一并
  // 剔除——此前 extra.code 可改写 err.code 使 exitCode 与最终 code 脱钩）
  const { exitCode: _protectedExitCode, code: _protectedCode, message: _protectedMessage, ...rest } = extra || {};
  Object.assign(err, rest);
  return err;
}

/**
 * 判断是否为 DSH 统一错误（带 ERR_ 前缀 code）。
 * @param {unknown} err
 * @returns {boolean}
 */
function isDshError(err) {
  return Boolean(err && typeof err === 'object' && typeof err.code === 'string' && err.code.startsWith('ERR_'));
}

// 历史别名（launcher 早期命名；新代码统一用 isDshError）
const isLauncherError = isDshError;

module.exports = {
  ERROR_CODES,
  EXIT_CODE_BY_PREFIX,
  exitCodeForCode,
  makeError,
  isDshError,
  isLauncherError
};
