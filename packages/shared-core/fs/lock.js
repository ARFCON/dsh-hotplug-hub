'use strict';
// fs/lock.js — 统一文件锁（H-4/M-12，CONTRACT.md 钉死协议）
//
// 协议（跨语言一致，C# / dseam / launcher / memory-hub 共用）：
//   - 锁文件：openSync(lockPath, 'wx') 独占创建（= C# FileMode.CreateNew），
//     权限 0o600；创建失败 EEXIST 表示他人持有。
//   - token 格式：两行文本 `pid\nunix_ms\n`（pid 十进制、unix 毫秒时间戳）。
//   - pid 探活：process.kill(pid, 0)——ESRCH=已死（可立即接管）；EPERM=存活但
//     无权限（保守不接管）；其它异常=存活。
//   - 过期接管：token 年龄 > staleMs（默认 30s）视为陈旧可接管；pid 已死则无视
//     token 年龄立即接管（崩溃残留快速清理）。
//   - 他用户锁：openSync EACCES/EPERM（锁文件属于他人）→ 保守等待至超时，绝不接管。
//   - 持锁期刷新：持有者每 refreshMs（默认 10s）经已打开 fd 重写 token 时间戳，
//     防止长任务被误判陈旧（事件循环需可运行）。
//   - v1 目录锁迁移：lockPath 若为目录形态（v1）→ 读 <lockPath>/owner：
//     pid 存活且未过期 → 等待；否则清理目录重建为文件锁。
//
// 决策矩阵（acquire 失败路径）：
//   | 观测                                   | 动作                     |
//   |----------------------------------------|--------------------------|
//   | openSync 成功                          | 持有（写 token + 刷新）  |
//   | EEXIST + token 新 + pid 活             | 等待轮询                 |
//   | EEXIST + token 旧（>staleMs）          | 接管（unlink 重试）      |
//   | EEXIST + pid 死                        | 立即接管                 |
//   | EEXIST + EACCES/EPERM（他用户）        | 等待至超时，不接管       |
//   | token 缺失/损坏                        | 按文件 mtime 判陈旧      |
const fs = require('fs');
const { dirname, join } = require('path');
const {
  LOCK_WAIT_MS,
  LOCK_STALE_MS,
  LOCK_POLL_MS,
  LOCK_REFRESH_MS
} = require('../contracts/constants');
const { makeError } = require('../contracts/errors');

function sleepSync(ms) {
  // 主线程同步睡眠（Atomics.wait 在 Node 主线程可用）
  const sab = new SharedArrayBuffer(4);
  const arr = new Int32Array(sab);
  Atomics.wait(arr, 0, 0, ms);
}

/**
 * 解析 token 文本（`pid\nunix_ms`）。
 * @param {string} text
 * @returns {{pid: number, at: number}|null}
 */
function parseToken(text) {
  if (typeof text !== 'string') return null;
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) return null;
  // 严格十进制（审计修复）：token 契约是「纯十进制 pid + unix 毫秒时间戳」。
  // 此前 Number.parseInt 对 `123abc`/`1.5`/超长数字都返回前缀整数，且 Number.isInteger
  // 对 parseInt 结果恒真，导致损坏 token 被误判为有效 (pid,at)——与「token 缺失/损坏
  // → 回退 mtime 判定」的意图相悖。现要求两行均为纯十进制且在安全整数范围，否则 null。
  if (!/^[0-9]+$/.test(lines[0]) || !/^[0-9]+$/.test(lines[1])) return null;
  const pid = Number(lines[0]);
  const at = Number(lines[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(at) || at <= 0) return null;
  return { pid, at };
}

/** 序列化 token（协议钉死：pid\nunix_ms\n）。 */
function formatToken(pid, at) {
  return `${pid}\n${at}\n`;
}

/**
 * 原子重写锁 token（先整体覆盖、后截断到精确长度）。
 * 关键修复（CI flaky 根因）：绝不可在写前 truncate——"truncate→write" 两步之间会
 * 留出空文件窗口，并发读者（readToken）读到空文件即判锁损坏（readToken 返回 null）；
 * 改为"write(offset 0)→ftruncate(精确长度)"，读者任一时刻要么读到旧 token、要么读到
 * 新 token，绝不为空；写后截断又保证 token 变短时无残留字节。
 * @param {number} fd 已打开的锁 fd（绑定获取锁时的 inode，见 P1b）
 * @param {number} pid 持有者 pid
 * @param {object} [opts]
 * @param {object} [opts.fsImpl] fs 实现（默认 node:fs；测试注入假实现校验调用顺序）
 * @param {number} [opts.at] 时间戳（默认 Date.now；测试注入固定值）
 * @returns {string} 写入的 token 文本
 */
function rewriteToken(fd, pid, opts = {}) {
  const fsImpl = opts.fsImpl || fs;
  const ts = opts.at === undefined ? Date.now() : opts.at;
  const buf = Buffer.from(formatToken(pid, ts), 'utf8');
  fsImpl.writeSync(fd, buf, 0, buf.length, 0);
  fsImpl.ftruncateSync(fd, buf.length);
  return formatToken(pid, ts);
}

/**
 * 读取锁 token（文件不存在/损坏返回 null）。
 * @param {object} fsPort
 * @param {string} lockPath
 * @returns {{pid: number, at: number}|null}
 */
function readToken(fsPort, lockPath) {
  try {
    return parseToken(fsPort.readFileSync(lockPath, 'utf8'));
  } catch (_) {
    return null;
  }
}

/**
 * pid 探活：0=存活；1=已死（ESRCH）；2=存活但无权限（EPERM，保守）。
 * @param {number} pid
 * @returns {number}
 */
function probePid(pid) {
  try {
    process.kill(pid, 0);
    return 0;
  } catch (e) {
    if (e.code === 'ESRCH') return 1;
    if (e.code === 'EPERM') return 2;
    return 0; // 其它异常按存活处理（保守）
  }
}

/**
 * 判断锁是否陈旧可接管。
 * @param {{pid: number, at: number}|null} token
 * @param {number} nowMs 当前时间
 * @param {number} staleMs 过期阈值
 * @returns {boolean}
 */
function isStale(token, nowMs, staleMs) {
  if (!token) return true; // token 缺失/损坏：交由 mtime 回退判定（调用方处理）
  const alive = probePid(token.pid);
  if (alive === 1) return true; // pid 已死：立即接管（崩溃残留）
  if (alive === 2) return false; // 他用户进程：保守不接管
  return nowMs - token.at > staleMs; // pid 存活：按 token 年龄判定
}

/**
 * 检查 lockPath 是否为 v1 目录锁形态。
 * @param {object} fsPort
 * @param {string} lockPath
 * @returns {boolean}
 */
function isDirectoryLock(fsPort, lockPath) {
  try {
    const st = fsPort.statSync(lockPath);
    return st.isDirectory();
  } catch (_) {
    return false;
  }
}

/**
 * v1 目录锁迁移：目录形态锁 → 读 owner 判定。
 * @param {object} fsPort
 * @param {string} lockPath
 * @param {object} opts { now, staleMs }
 * @returns {{held: boolean}} held=true 表示目录锁仍被持有（应等待）
 */
function checkV1DirectoryLock(fsPort, lockPath, opts) {
  const now = opts.now || Date.now;
  const staleMs = opts.staleMs === undefined ? LOCK_STALE_MS : opts.staleMs;
  const ownerPath = join(lockPath, 'owner');
  let ownerInfo = null;
  try {
    ownerInfo = JSON.parse(fsPort.readFileSync(ownerPath, 'utf8'));
  } catch (_) {
    ownerInfo = null;
  }
  if (ownerInfo && typeof ownerInfo === 'object') {
    const ownerStr = typeof ownerInfo.owner === 'string' ? ownerInfo.owner : '';
    const m = /pid-(\d+)/.exec(ownerStr);
    const pid = m ? Number.parseInt(m[1], 10) : NaN;
    const at = typeof ownerInfo.at === 'number' ? ownerInfo.at : Date.parse(String(ownerInfo.at));
    if (Number.isInteger(pid) && pid > 0 && !Number.isNaN(at)) {
      const alive = probePid(pid);
      const fresh = now() - at <= staleMs;
      if (alive !== 1 && fresh) return { held: true }; // 持有者存活且未过期
    }
  }
  // 无有效 owner 或已过期：清理目录重建为文件锁。
  // 审计修复（根治）：fsPort 方法契约此前未文档化，消费方（dseam-skillmcp / dsh-memory-hub）
  // 的直连端口缺 rmdirSync → `fsPort.rmdirSync(lockPath)` 抛 TypeError 被吞、v1 目录锁
  // 永久残留、锁获取恒失败（子进程实证）。改为优先 rmSync（四个消费方均具备；递归 +
  // force 容错竞态），回退 unlink owner + rmdirSync（老端口兼容）。
  try {
    if (typeof fsPort.rmSync === 'function') {
      fsPort.rmSync(lockPath, { recursive: true, force: true });
    } else {
      if (fsPort.existsSync(ownerPath)) fsPort.unlinkSync(ownerPath);
      if (typeof fsPort.rmdirSync === 'function') fsPort.rmdirSync(lockPath);
    }
  } catch (_) { /* 清理失败：交由后续 openSync 的 EEXIST 路径等待 */ }
  return { held: false };
}

/**
 * 启动锁 token 心跳。
 * P1 修复：优先用 Worker 线程（独立事件循环）——主线程执行阻塞式 spawnSync 时
 * setInterval 无法触发，token 会陈旧被第二写者接管；Worker 线程不受主线程阻塞影响。
 * Worker 不可用（环境限制）时回退主线程 setInterval（尽力而为，阻塞期间仍可能陈旧）。
 *
 * P1b 修复（跨线程覆盖竞态）：Worker 经【主线程传入的持有 fd】写 token，绝不按路径
 * 重开——按路径重开会在 release→reacquire 窗口打开新持有者的锁文件并用旧 pid 覆盖其
 * token。fd 绑定获取锁时创建的 inode，release 后重建同名文件也不受影响。
 * 同步停止握手：返回 heartbeat 句柄含 stop()，其置停止请求 + 等 Worker 确认后再让
 * 调用方关 fd（见 releaseLock）。
 * @param {object} fsPort fs 端口（回退路径用）
 * @param {number} pid 持有者 pid
 * @param {number} refreshMs 刷新周期（0=不刷新，返回 null）
 * @param {number} fd 主线程已打开的锁 fd（Worker 经此写；回退路径重写 token 用）
 * @param {Function} [now] 时钟注入（默认 Date.now；仅 setInterval 回退路径使用。
 *   Worker 线程无法结构化克隆函数、固定用 Date.now——生产 now≡Date.now 语义一致）
 * @returns {{stop: Function}|object|null} heartbeat 句柄或 interval 句柄
 */
function startHeartbeat(fsPort, pid, refreshMs, fd, now) {
  if (!(refreshMs > 0)) return null;
  try {
    const { Worker } = require('worker_threads');
    const ctrl = new SharedArrayBuffer(8); // 2×Int32：c[0]=停止请求，c[1]=已停止确认
    const worker = new Worker(join(__dirname, 'lock-heartbeat.js'), {
      workerData: { fd, pid, refreshMs, ctrl }
    });
    if (typeof worker.unref === 'function') worker.unref();
    const c = new Int32Array(ctrl);
    return {
      stop() {
        // 请求停止并等待 Worker 确认：确认后 Worker 绝不再写，调用方可安全关 fd。
        Atomics.store(c, 0, 1);
        Atomics.notify(c, 0);
        const deadline = Date.now() + 1000;
        while (Atomics.load(c, 1) === 0 && Date.now() < deadline) {
          // Worker 收到 notify 后应立即置 c[1]=1；此处短暂自旋兜底（Worker 崩溃/未启动）
          Atomics.wait(c, 1, 0, 50);
        }
        try { worker.terminate(); } catch (_) { /* 忽略 */ }
      }
    };
  } catch (_) {
    // Worker 不可用（worker_threads 缺失/创建失败）→ 回退主线程 setInterval
    if (typeof setInterval !== 'function') return null;
    const timer = setInterval(() => {
      try {
        // 审计修复：注入时钟须贯穿回退路径——此前 rewriteToken 缺省 Date.now()，
        // 与 acquireLock/isStale 的 opts.now 陈旧判定脱钩（冻结时钟下 token 永不陈旧）。
        rewriteToken(fd, pid, { fsImpl: fsPort, at: (now || Date.now)() });
      } catch (_) { /* 刷新失败：陈旧接管兜底 */ }
    }, refreshMs);
    if (typeof timer.unref === 'function') timer.unref();
    return { stop() { clearInterval(timer); } };
  }
}

/**
 * 获取文件锁。
 * @param {object} fsPort fs 端口。本函数与 releaseLock/checkV1DirectoryLock 依赖的方法：
 *   mkdirSync / openSync / writeFileSync / fsyncSync / closeSync / existsSync / statSync /
 *   unlinkSync / readFileSync，以及 v1 目录锁迁移所需的 rmSync（优先）或 rmdirSync。
 *   消费方直连 node:fs 端口必须含上述方法（缺失 rmdirSync 时 rmSync 兜底，见 checkV1DirectoryLock）。
 * @param {string} lockPath 锁文件路径
 * @param {object} [opts]
 * @param {number} [opts.waitMs] 等待上限（默认 10s）
 * @param {number} [opts.staleMs] 过期接管阈值（默认 30s）
 * @param {number} [opts.pollMs] 轮询间隔（默认 100ms）
 * @param {number} [opts.refreshMs] 持锁刷新间隔（默认 10s；0=不刷新）
 * @param {Function} [opts.now] 时钟注入（默认 Date.now）
 * @param {string} [opts.owner] 所有者标识（默认 pid-<pid>）
 * @param {number} [opts.pid] 所有者 pid（默认 process.pid；测试可注入）
 * @returns {{ok: boolean, fd?: number, owner?: string, token?: object, error?: Error}}
 */
function acquireLock(fsPort, lockPath, opts = {}) {
  const waitMs = opts.waitMs === undefined ? LOCK_WAIT_MS : opts.waitMs;
  const staleMs = opts.staleMs === undefined ? LOCK_STALE_MS : opts.staleMs;
  const pollMs = opts.pollMs === undefined ? LOCK_POLL_MS : opts.pollMs;
  const refreshMs = opts.refreshMs === undefined ? LOCK_REFRESH_MS : opts.refreshMs;
  const now = opts.now || Date.now;
  const pid = opts.pid === undefined ? process.pid : opts.pid;
  const owner = opts.owner || `pid-${pid}`;
  const deadline = now() + waitMs;

  for (;;) {
    // v1 目录锁迁移（检测到目录形态时）
    if (isDirectoryLock(fsPort, lockPath)) {
      const v1 = checkV1DirectoryLock(fsPort, lockPath, { now, staleMs });
      if (v1.held) {
        if (now() >= deadline) {
          return { ok: false, error: makeError('ERR_LOCK_ACQUIRE', `等待锁超时（${waitMs}ms）：${lockPath}`) };
        }
        sleepSync(pollMs);
        continue;
      }
      // 已清理，继续走文件锁创建
    }
    let fd = null;
    try {
      // 先确保父目录存在
      fsPort.mkdirSync(dirname(lockPath), { recursive: true });
      fd = fsPort.openSync(lockPath, 'wx', 0o600);
      const token = { pid, at: now() };
      try {
        fsPort.writeFileSync(fd, formatToken(pid, token.at), 'utf8');
        if (typeof fsPort.fsyncSync === 'function') fsPort.fsyncSync(fd);
      } catch (writeErr) {
        try { fsPort.closeSync(fd); } catch (_) { /* 忽略 */ }
        try { if (fsPort.existsSync(lockPath)) fsPort.unlinkSync(lockPath); } catch (_) { /* 忽略 */ }
        return { ok: false, error: makeError('ERR_LOCK_ACQUIRE', `写入锁 token 失败 ${lockPath}：${writeErr.message}`) };
      }
      // 持锁期刷新：Worker 线程心跳（独立事件循环）——主线程阻塞 spawnSync 时
      // setInterval 无法触发，token 会陈旧被第二写者接管（P1）；Worker 不受影响。
      const refresh = startHeartbeat(fsPort, pid, refreshMs, fd, now);
      const release = () => releaseLock(fsPort, lockPath, { owner, pid, fd, refresh });
      // 审计修复：返回 refresh 句柄——此前调用方（pipeline/index 等）直接 releaseLock
      // {owner,pid,fd} 而不传 refresh，导致持锁期 setInterval 定时器在释放后泄漏、
      // 每 10s 对已关闭 fd 写 token（EBADF 被吞）。返回后调用方须在 releaseLock 时
      // 一并传入 refresh 以清理定时器。
      return { ok: true, fd, owner, token, release, refresh };
    } catch (e) {
      if (fd !== null) {
        try { fsPort.closeSync(fd); } catch (_) { /* 忽略 */ }
      }
      // mkdir 阶段 EEXIST（recursive 下路径已存在且非目录，如父路径被文件占位）：
      // 永久性失败，立即返回而非轮询等待
      if (e.syscall === 'mkdir' && e.code === 'EEXIST') {
        return { ok: false, error: makeError('ERR_LOCK_ACQUIRE', `创建锁失败（父路径被文件占位）${lockPath}：${e.message}`) };
      }
      if (e.code !== 'EEXIST') {
        // 他用户锁（EACCES/EPERM）保守不接管：等待至超时
        if ((e.code === 'EACCES' || e.code === 'EPERM') && now() < deadline) {
          sleepSync(pollMs);
          continue;
        }
        return { ok: false, error: makeError('ERR_LOCK_ACQUIRE', `创建锁失败 ${lockPath}：${e.message}`) };
      }
      // 锁已存在：读取 token 判定陈旧
      const token = readToken(fsPort, lockPath);
      if (token) {
        if (!isStale(token, now(), staleMs)) {
          if (now() >= deadline) {
            return { ok: false, error: makeError('ERR_LOCK_ACQUIRE', `等待锁超时（${waitMs}ms）：${lockPath}`) };
          }
          sleepSync(pollMs);
          continue;
        }
      } else {
        // token 缺失/损坏：回退文件 mtime 判定
        try {
          const st = fsPort.statSync(lockPath);
          if (now() - st.mtimeMs <= staleMs) {
            if (now() >= deadline) {
              return { ok: false, error: makeError('ERR_LOCK_ACQUIRE', `等待锁超时（${waitMs}ms）：${lockPath}`) };
            }
            sleepSync(pollMs);
            continue;
          }
        } catch (_) {
          // stat 失败（锁刚被删或父路径异常）：受 deadline 约束的重试，绝不无限自旋
          if (now() >= deadline) {
            return { ok: false, error: makeError('ERR_LOCK_ACQUIRE', `等待锁超时（${waitMs}ms）：${lockPath}`) };
          }
          sleepSync(pollMs);
          continue;
        }
      }
      // 接管：unlink 后重试。R3（二次确认，兑现注释声称的防竞态）：决策（readToken
      // → isStale）与 unlink 之间，另一等待者可能已完成接管并写入新 token——此时
      // unlink 删掉的是【活锁】（双持有者窗口）。unlink 前重读 token，与决策时
      // 完全一致（pid + at）才执行；不一致（已被人接管/刷新）则回到循环按新状态
      // 重新判定。token 缺失走 mtime 回退的路径同理：重读可解析（新持有者已落
      // token）或 mtime 已刷新时同样不接管。
      const again = readToken(fsPort, lockPath);
      // 审查修复（防忙转）：重判 continue 前睡一个 poll 周期——持续 token 抖动
      //（对抗性/极端竞态）时不得以全速 open+read 自旋占满 CPU。
      // D3 修复：这些「接管前重读」抖动 continue 分支此前不查 deadline，陈旧 token
      // 持续抖动时无限自旋、waitMs 超时契约失效（子进程实证：永不返回）。现每个分支
      // 在重试前先查 deadline，与上方「等待」分支的语义一致。
      const backoff = () => {
        if (now() >= deadline) {
          return makeError('ERR_LOCK_ACQUIRE', `等待锁超时（${waitMs}ms）：${lockPath}`);
        }
        sleepSync(pollMs);
        return null;
      };
      if (token && !again) {
        const to = backoff(); if (to) return { ok: false, error: to };
        continue; // token 瞬时不可解析（并发重写窗口）：重新判定，不盲目接管
      }
      if (token && again && (again.pid !== token.pid || again.at !== token.at)) {
        const to = backoff(); if (to) return { ok: false, error: to };
        continue; // token 已变：按新持有者重新走等待/接管判定
      }
      if (!token && again) {
        const to = backoff(); if (to) return { ok: false, error: to };
        continue; // mtime 回退路径上出现可解析 token：同上，重新判定
      }
      if (!token) {
        // mtime 回退路径：mtime 已被刷新（新持有者 touch）则不接管
        try {
          const st2 = fsPort.statSync(lockPath);
          if (now() - st2.mtimeMs <= staleMs) {
            const to = backoff(); if (to) return { ok: false, error: to };
            continue;
          }
        } catch (_) {
          if (now() >= deadline) {
            return { ok: false, error: makeError('ERR_LOCK_ACQUIRE', `等待锁超时（${waitMs}ms）：${lockPath}`) };
          }
          sleepSync(pollMs);
          continue;
        }
      }
      try {
        fsPort.unlinkSync(lockPath);
      } catch (unlinkErr) {
        if (unlinkErr.code === 'ENOENT') continue; // 已被他人接管删除：重试
        return { ok: false, error: makeError('ERR_LOCK_ACQUIRE', `接管过期锁失败 ${lockPath}：${unlinkErr.message}`) };
      }
    }
  }
}

/**
 * 释放文件锁。
 * @param {object} fsPort
 * @param {string} lockPath
 * @param {object} [opts]
 * @param {string} [opts.owner] 期望的所有者标识（默认 pid-<pid>）；不匹配时拒绝释放
 * @param {number} [opts.pid] 期望的所有者 pid（默认 process.pid）
 * @param {number} [opts.fd] acquireLock 返回的 fd（先关闭再 unlink，Windows 语义）
 * @param {object} [opts.refresh] acquireLock 内部刷新定时器（一并清理）
 * @returns {{ok: boolean, error?: Error}}
 */
function releaseLock(fsPort, lockPath, opts = {}) {
  const pid = opts.pid === undefined ? process.pid : opts.pid;
  const owner = opts.owner || `pid-${pid}`;
  try {
    if (opts.refresh) {
      // P1b 修复：refresh 统一为 heartbeat/interval 句柄（含 stop()）。
      // stop() 先停 Worker 并等其确认（heartbeat）或 clearInterval（interval），
      // 确保返回后不再有 token 写，调用方随后关 fd / unlink 才安全。
      // 兼容旧形态（裸 Worker/interval）以防调用方仍传旧值。
      try {
        if (typeof opts.refresh.stop === 'function') opts.refresh.stop();
        else if (typeof opts.refresh.terminate === 'function') opts.refresh.terminate();
        else clearInterval(opts.refresh);
      } catch (_) { /* 忽略 */ }
    }
    const token = readToken(fsPort, lockPath);
    if (token && token.pid !== pid) {
      return { ok: false, error: makeError('ERR_LOCK_ACQUIRE', `释放锁失败：token pid 不匹配（${token.pid} vs ${pid}），拒绝释放他人锁`) };
    }
    if (opts.fd !== undefined) {
      try { fsPort.closeSync(opts.fd); } catch (_) { /* 忽略 */ }
    }
    if (fsPort.existsSync(lockPath)) fsPort.unlinkSync(lockPath);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: makeError('ERR_LOCK_ACQUIRE', `释放锁失败 ${lockPath}：${e.message}`) };
  }
}

module.exports = { acquireLock, releaseLock, readToken, parseToken, formatToken, rewriteToken, isStale, probePid, isDirectoryLock };
