'use strict';
// infra/lock.js — 目录锁（30s 过期接管 / 10s 等待 / 100ms 轮询）
//
// 审计修复：并发产物撕裂风险；写命令（assemble/install/sync/launch/heal/rollback）
// 必须持锁，只读命令（check/status/logs）不持锁。
const {
  LOCK_WAIT_MS,
  LOCK_STALE_MS,
  LOCK_POLL_MS
} = require('../contracts/constants');
const { makeError } = require('../contracts/errors');

function sleepSync(ms) {
  // 主线程同步睡眠（Atomics.wait 在 Node 主线程可用）
  const sab = new SharedArrayBuffer(4);
  const arr = new Int32Array(sab);
  Atomics.wait(arr, 0, 0, ms);
}

/**
 * 读取锁 owner 标记（不存在/损坏返回 null）。
 * @param {object} fsPort
 * @param {string} lockPath
 * @returns {{owner: string, at: string}|null}
 */
function readOwner(fsPort, lockPath) {
  try {
    return JSON.parse(fsPort.readFileSync(pathJoin(lockPath, 'owner'), 'utf8'));
  } catch (_) {
    return null;
  }
}

/**
 * 获取目录锁。
 * @param {object} fsPort fs 端口
 * @param {string} lockPath 锁目录路径
 * @param {object} [opts]
 * @param {number} [opts.waitMs] 等待上限（默认 10s）
 * @param {number} [opts.staleMs] 过期接管阈值（默认 30s）
 * @param {Function} [opts.now] 时钟注入（默认 Date.now）
 * @param {string} [opts.owner] 所有者标识（默认 pid）
 * @returns {{ok: boolean, error?: Error}}
 */
function acquireLock(fsPort, lockPath, opts = {}) {
  const waitMs = opts.waitMs === undefined ? LOCK_WAIT_MS : opts.waitMs;
  const staleMs = opts.staleMs === undefined ? LOCK_STALE_MS : opts.staleMs;
  const now = opts.now || Date.now;
  const owner = opts.owner || `pid-${process.pid}`;
  const deadline = now() + waitMs;

  for (;;) {
    try {
      // 先确保父目录存在（递归创建），锁目录本身必须原子独占创建
      fsPort.mkdirSync(pathDirname(lockPath), { recursive: true });
      fsPort.mkdirSync(lockPath, { recursive: false });
      // at 用 ISO 字符串（readOwner 以 Date.parse 读取）
      try {
        fsPort.writeFileSync(pathJoin(lockPath, 'owner'), JSON.stringify({ owner, at: new Date(now()).toISOString() }), 'utf8');
      } catch (writeErr) {
        // C4 修复：owner 写入失败（ENOSPC/EACCES 等）必须清理刚创建的锁目录，
        // 否则空锁目录残留会让后续获取者按 mtime 回退阻塞至超时（30s 才过期）。
        try {
          if (fsPort.existsSync(pathJoin(lockPath, 'owner'))) fsPort.unlinkSync(pathJoin(lockPath, 'owner'));
          if (fsPort.existsSync(lockPath)) fsPort.rmdirSync(lockPath);
        } catch (_) { /* 清理失败可忽略 */ }
        return { ok: false, error: makeError('ERR_LOCK_ACQUIRE', `写入锁 owner 失败 ${lockPath}：${writeErr.message}`) };
      }
      return { ok: true };
    } catch (e) {
      if (e.code !== 'EEXIST') {
        return { ok: false, error: makeError('ERR_LOCK_ACQUIRE', `创建锁失败 ${lockPath}：${e.message}`) };
      }
      // 锁已存在：判断是否过期（FIX-10：基于 owner 标记时间戳而非目录 mtime，接管前二次确认）
      let stale = false;
      const ownerInfo = readOwner(fsPort, lockPath);
      if (!ownerInfo) {
        // owner 缺失/损坏：回退目录 mtime 判断
        try {
          const st = fsPort.statSync(lockPath);
          if (now() - st.mtimeMs > staleMs) stale = true;
        } catch (_) {
          stale = true;
        }
      } else {
        // 兼容 at 为毫秒数字（旧测试）与 ISO 字符串（当前实现）
        const ownerAt = typeof ownerInfo.at === 'number' ? ownerInfo.at : Date.parse(ownerInfo.at);
        if (Number.isNaN(ownerAt) || now() - ownerAt > staleMs) stale = true;
      }
      if (stale) {
        try {
          // FIX-10：接管前二次确认——重读 owner，若已被他人更新（未过期）则放弃接管继续等待
          const recheck = readOwner(fsPort, lockPath);
          if (recheck) {
            const at2 = typeof recheck.at === 'number' ? recheck.at : Date.parse(recheck.at);
            if (!Number.isNaN(at2) && now() - at2 <= staleMs) {
              // 锁刚被他人更新：不接管，继续等待
              if (now() >= deadline) {
                return { ok: false, error: makeError('ERR_LOCK_ACQUIRE', `等待锁超时（${waitMs}ms）：${lockPath}`) };
              }
              sleepSync(LOCK_POLL_MS);
              continue;
            }
          }
          // 先删 owner 标记，再用非递归 rmdir 清理空锁目录（避免递归 rm 被环境拦截）
          if (fsPort.existsSync(pathJoin(lockPath, 'owner'))) fsPort.unlinkSync(pathJoin(lockPath, 'owner'));
          fsPort.rmdirSync(lockPath);
          continue; // 接管后重试
        } catch (rmErr) {
          return { ok: false, error: makeError('ERR_LOCK_ACQUIRE', `接管过期锁失败 ${lockPath}：${rmErr.message}`) };
        }
      }
      if (now() >= deadline) {
        return { ok: false, error: makeError('ERR_LOCK_ACQUIRE', `等待锁超时（${waitMs}ms）：${lockPath}`) };
      }
      sleepSync(LOCK_POLL_MS);
    }
  }
}

function pathJoin(dir, name) {
  // 避免顶层引入 path 依赖（保持 infra 显式注入原则之外的轻量拼接）
  const sep = dir.endsWith('/') || dir.endsWith('\\') ? '' : '/';
  return dir + sep + name;
}

// path.dirname 用于创建锁父目录（Node 内建，纯函数）
const { dirname: pathDirname } = require('path');

/**
 * 释放目录锁。
 * @param {object} fsPort
 * @param {string} lockPath
 * @param {object} [opts]
 * @param {string} [opts.owner] 期望的所有者标识（默认 pid）；不匹配时拒绝释放（FIX-10）
 * @returns {{ok: boolean, error?: Error}}
 */
function releaseLock(fsPort, lockPath, opts = {}) {
  const owner = opts.owner || `pid-${process.pid}`;
  try {
    const info = readOwner(fsPort, lockPath);
    if (info && info.owner !== owner) {
      return { ok: false, error: makeError('ERR_LOCK_ACQUIRE', `释放锁失败：owner 不匹配（${info.owner} vs ${owner}），拒绝释放他人锁`) };
    }
    // C4 修复：owner 缺失/损坏时（另一进程正处于"mkdir 成功、owner 未写"窗口），
    // 仅当锁目录为空才允许清理；非空（他人已写入 owner 或正在持有）拒绝释放，
    // 防止误删他人刚创建的锁。
    if (!info) {
      let entries = [];
      try {
        entries = fsPort.readdirSync(lockPath);
      } catch (_) { /* 目录不存在则按已释放处理 */ }
      if (entries.length > 0) {
        return { ok: false, error: makeError('ERR_LOCK_ACQUIRE', `释放锁失败：owner 标记缺失但锁目录非空（${entries.length} 项），拒绝释放`) };
      }
    }
    if (fsPort.existsSync(pathJoin(lockPath, 'owner'))) fsPort.unlinkSync(pathJoin(lockPath, 'owner'));
    if (fsPort.existsSync(lockPath)) fsPort.rmdirSync(lockPath);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: makeError('ERR_LOCK_ACQUIRE', `释放锁失败 ${lockPath}：${e.message}`) };
  }
}

module.exports = { acquireLock, releaseLock, readOwner };
