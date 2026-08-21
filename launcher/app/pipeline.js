'use strict';
// app/pipeline.js — 状态机驱动流水线编排（薄编排层）
//
// 流程：组装 → 校验 → 解析 → 冲突 → 安装 → 同步 → 启动 → 监控
// 职责：统一 id 校验、state 读写、写命令持锁、阶段分发、持久化。
// 阶段实现见 app/stages.js；Domain 纯函数零副作用；副作用只经端口。
const path = require('path');
const { STATE_FILE } = require('../contracts/constants');
const { makeError } = require('../contracts/errors');
const {
  STAGES,
  okResult,
  errResult,
  sandboxDir,
  stateFilePathFor,
  runLogFileFor
} = require('./stages');

const WRITE_COMMANDS = new Set(['assemble', 'install', 'launch', 'heal', 'rollback']);

/**
 * 流水线主入口。
 * @param {object} core
 * @param {string} command assemble|check|install|launch|heal|status|rollback|logs
 * @param {object} args { id, yes, wait, timeoutMs, tail }
 * @returns {Promise<object>} CommandResult
 */
async function runPipeline(core, command, args) {
  const { id } = args;
  const fsPort = core.ports.fs;
  const roots = core.config.roots;

  // 统一 id 前置校验（D/N30/N31/N32/N43 修复）
  // M-26 修复（v5 阶段 2）：绑定到根域（.dsh，store/profiles 的共同父级）而非
  // store 子目录——id 将落盘于 assembly/sandbox/profile/store 多处，语义上属于根域。
  const idCheck = core.domain.ids.normalizeAndAssert(id, path.dirname(roots.storeRoot));
  if (!idCheck.ok) return errResult(idCheck.error);

  const stateFile = stateFilePathFor(core, id);

  // 写命令持文件锁（并发撕裂防护，H-4：shared fs/lock 文件锁 + v1→v2 迁移）；
  // 只读命令（check/status/logs）不持锁
  const lockPath = path.join(roots.storeRoot, id, '.lock');
  let lock = null;
  if (WRITE_COMMANDS.has(command)) {
    lock = core.infra.lock.acquireLock(fsPort, lockPath, { now: core.ports.now.now });
    if (!lock.ok) return errResult(lock.error);
    core._activeLock = { ...lock, lockPath }; // FIX-12：暴露当前锁（含 fd/owner）供信号处理器释放
  }

  try {
    // C7 修复：state 读取移到锁内——此前"先读后锁"使读-改-写非原子，
    // 并发写命令（如 launch 与 heal 同 id）会互相覆盖对方的 retries/history
    // （后写者用过期快照覆盖先写者的更新）。锁内读取保证整个
    // read-modify-write 周期串行。
    const read = core.infra.store.readState(fsPort, stateFile);
    if (!read.ok) return errResult(read.error);
    const state = read.state || core.infra.store.createEmptyState(id);

    const stage = STAGES[command];
    if (!stage) {
      return errResult(makeError('ERR_ARG_UNKNOWN_COMMAND', `未知命令：${command}`));
    }
    const result = await stage(core, state, args);
    // FIX-4：写命令且 state 有变更即持久化（成败都写）——失败路径的 retries/heal history 不得丢失。
    // try 包裹：state 写失败不掩盖主命令结果（仅记录于返回数据）。
    if (WRITE_COMMANDS.has(command) && state.dirty) {
      const w = core.infra.store.writeState(fsPort, stateFile, state);
      if (!w.ok) {
        if (result.ok) return errResult(w.error);
        result.data = { ...(result.data || {}), stateWriteError: w.error.message };
      }
    }
    return result;
  } finally {
    if (lock) {
      core.infra.lock.releaseLock(fsPort, lockPath, { owner: lock.owner, pid: process.pid, fd: lock.fd });
      core._activeLock = null;
    }
  }
}

module.exports = { runPipeline, okResult, errResult, sandboxDir, stateFilePathFor, runLogFileFor };
