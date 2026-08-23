'use strict';
// fs/lock-heartbeat.js — 锁 token 心跳（Worker 线程，独立事件循环）
//
// 背景（P1 修复）：主线程持锁期间若执行阻塞式 spawnSync（npm/git 安装 >30s），
// 事件循环冻结，setInterval 无法触发 → token 时间戳不再刷新 → 第二写者按
// "存活 pid + token 超龄"判定陈旧并接管锁，破坏并发写互斥。
// 本 Worker 运行在独立线程，其事件循环与主线程互不阻塞，故即使主线程卡在
// spawnSync，token 仍按 refreshMs 周期刷新，锁的陈旧判定契约（CONTRACT.md §5）
// 得以维持。
//
// 审计修复（P1b，跨线程覆盖竞态）：此前每 tick 用 fs.openSync(lockPath, 'r+')
// 按【路径】重开锁文件写 token——release 后主线程 unlink 旧锁、另一进程在同路径
// 重建新锁，若本 Worker 尚未被 terminate（terminate 异步、存在窗口），下一次 tick
// 会打开【新持有者的锁文件】并用旧 pid 覆盖其 token，击穿跨进程互斥（已实证复现）。
//
// 根因修复：Worker 不按路径重开，改经【主线程传入的持有 fd】写——该 fd 由
// acquireLock 用 'wx' 独占创建、绑定获取锁时创建的固定 inode；release 后主线程
// unlink + 重建同名文件，本 fd 仍指向旧的（已 unlink）inode，写入不影响新持有者。
//
// 同步停止握手：主线程 releaseLock 先 Atomics.store(ctrl[0]=1) 请求停止并
// Atomics.notify 唤醒本 Worker，再 Atomics.wait(ctrl[1]==1) 等待确认；本 Worker
// 仅在 while 条件（ctrl[0]==0）为真时写，收到停止请求后【绝不再写】，随后置
// ctrl[1]=1 确认并退出。主线程在收到确认前不关闭 fd → 不存在"写已关闭/被复用 fd"
// 的窗口（fd 复用竞态一并消除）。
const { workerData } = require('worker_threads');
const fs = require('fs');

const { fd, pid, refreshMs, ctrl } = workerData;
const c = new Int32Array(ctrl); // c[0]=停止请求（主线程写）；c[1]=已停止确认（本 Worker 写）

while (Atomics.load(c, 0) === 0) {
  try {
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, `${pid}\n${Date.now()}\n`, 0, 'utf8');
  } catch (_) { /* 刷新失败：下次重试；陈旧接管兜底 */ }
  // 阻塞至 refreshMs 或主线程请求停止（Atomics.notify 立即唤醒）
  Atomics.wait(c, 0, 0, refreshMs);
}

// 确认停止并退出（主线程据此决定关闭 fd 的时机）
Atomics.store(c, 1, 1);
Atomics.notify(c, 1);
process.exit(0);
