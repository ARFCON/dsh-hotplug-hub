'use strict';
// app/stages-util.js — stages 共享 helper（结果构造、路径推导、隔离名单）
const path = require('path');
const { STATE_FILE, RUN_LOG_FILE } = require('../contracts/constants');
const { exitCodeForCode } = require('../contracts/errors');

function okResult(message, data) {
  // 契约对齐（A2/C1 修复）：成功结果的 code 为 'OK'（手册 CommandResult 契约
  // { "ok": true, "code": "OK", ... }），不再是 null——机器消费方可区分
  // 成功（OK）与失败（ERR_*）。
  return { ok: true, code: 'OK', message, data, exitCode: 0 };
}

function errResult(error) {
  const code = error && error.code ? error.code : 'ERR_ENV_UNSUPPORTED';
  return {
    ok: false,
    code,
    message: error && error.message ? error.message : String(error),
    // D3 修复：失败路径同样可透出结构化诊断数据（如 stageCheck 的 stateDegraded）——
    // 由 makeError extra 的 data 字段承载，与 okResult 的 data 口径一致（诊断信息统一走 data）。
    data: error && error.data && typeof error.data === 'object' ? error.data : null,
    // 契约修复：exitCode 必须由 code 推导（无 code 兜底 ERR_ENV_UNSUPPORTED→12），
    // 不得信任外来 error.exitCode（code/exitCode 脱钩值会污染退出码契约——QA Bug #1 同源）。
    exitCode: exitCodeForCode(code)
  };
}

function sandboxDir(core, id) {
  return path.join(core.config.roots.sandboxRoot, id);
}

function stateFilePathFor(core, id) {
  return path.join(core.config.roots.storeRoot, id, STATE_FILE);
}

function runLogFileFor(core, id) {
  return path.join(sandboxDir(core, id), 'logs', RUN_LOG_FILE);
}

/** 当前被隔离的插件名集合（quarantine 消费统一入口）。 */
function quarantinedNames(state) {
  return state && Array.isArray(state.heal && state.heal.quarantined) ? state.heal.quarantined : [];
}

module.exports = { okResult, errResult, sandboxDir, stateFilePathFor, runLogFileFor, quarantinedNames };
