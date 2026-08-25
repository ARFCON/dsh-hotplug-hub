'use strict';
// infra/patch-lock.js — profile 补丁四写者锁（CONTRACT.md §5）
//
// 审计修复：launcher 写 cordis.patch.yml 的三处路径（syncProfile 整文件替换、
// applyExcludes 重写、heal 的 regenerate-patch）此前不取锁——契约常量 PATCH_LOCK_FILE
// （<profile>/.dsh-patch.lock，launcher/hotplug/dseam/C# 四写者共用）在 launcher 侧
// 零引用。hub 的 appendPatchBlock/removePatchBlock 持锁期间 launcher 并发写盘会互相
// 吞更新（整文件替换直接抹掉 hub 刚追加的 hotplug 块）。现统一经本模块取锁，
// 锁协议与 hub 完全同源（shared-core fs/lock 单一实现）。
const path = require('path');
const { acquireLock, releaseLock } = require('@dsh/shared-core/fs/lock');
const { PATCH_LOCK_FILE } = require('../contracts/constants');

/**
 * 在四写者补丁锁内同步执行 task。
 * @param {object} fsPort
 * @param {string} profileDir 目标 profile 目录（锁文件落在其下）
 * @param {() => object} task 同步任务（返回 {ok, ...} 形态）
 * @param {object} [opts]
 * @param {number} [opts.waitMs] 锁等待预算（默认 10000，与 hub appendPatchBlock 一致）
 * @returns {object} task 的返回值；锁不可得时 {ok:false, error:ERR_LOCK_ACQUIRE}
 */
function withPatchLock(fsPort, profileDir, task, opts = {}) {
  const lockPath = path.join(profileDir, PATCH_LOCK_FILE);
  const waitMs = typeof opts.waitMs === 'number' && opts.waitMs >= 0 ? opts.waitMs : 10000;
  const a = acquireLock(fsPort, lockPath, { waitMs, refreshMs: 5000 });
  if (!a.ok) {
    return { ok: false, error: a.error };
  }
  try {
    return task();
  } finally {
    try {
      releaseLock(fsPort, lockPath, { pid: process.pid, fd: a.fd, refresh: a.refresh });
    } catch (_) { /* 释放失败不掩盖 task 结果 */ }
  }
}

module.exports = { withPatchLock };
