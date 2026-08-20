'use strict';
// contracts/constants.js — 统一常量：路径 / 正则 / 镜像 / 预算（纯数据，无副作用）
const path = require('path');
const os = require('os');

// --- 正则（与既有 PACK_ID_RE / PLUGIN_NAME_RE / EXACT_VERSION_RE 保持一致）---
const PACK_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const PLUGIN_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

// Windows 保留设备名（N43：CON/NUL/COM1… 全部拒绝）
const RESERVED_WIN_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
]);

// GitHub 镜像源（O 缺陷修复：不再只出现在文案里，而是可执行重试列表）
const GITHUB_MIRRORS = [
  'https://ghfast.top/',
  'https://gh-proxy.com/',
  'https://ghproxy.net/'
];

// 状态与产物版本
const SCHEMA_VERSION = 1;
const HOTPACK_VERSION = '1.0';

// 长度预算
const MAX_ID_LENGTH = 64;
const MAX_PATCH_ID_LENGTH = 64;
const MAX_SOURCE_PATH_LENGTH = 4096;

// 日志滚动上限（N46：5MB 滚动）
const RUNLOG_MAX_BYTES = 5 * 1024 * 1024;

// 目录锁（30s 过期接管 / 10s 等待 / 100ms 轮询）
const LOCK_WAIT_MS = 10000;
const LOCK_STALE_MS = 30000;
const LOCK_POLL_MS = 100;

// 启动生命周期（detach 存活确认窗口；--wait 默认超时）
const LAUNCH_ALIVE_CHECK_MS = 500;
const LAUNCH_WAIT_TIMEOUT_MS = 120000;

// 崩溃循环判定（3 次 / 30s 窗口）
const CRASH_LOOP_THRESHOLD = 3;
const CRASH_LOOP_WINDOW_MS = 30000;

// 自愈默认重试预算
const DEFAULT_RETRY_BUDGET = 3;

// 产物文件名
const STATE_FILE = 'state.json';
const RUN_LOG_FILE = 'run.jsonl';
const PATCH_FILE = 'cordis.patch.yml';
const PROFILE_MANIFEST = 'package.json';

// 快照单文件体积上限（超过则只记哈希、内容走 .bak 目录）
const SNAPSHOT_INLINE_MAX_BYTES = 1024 * 1024;

/**
 * 计算默认根目录。
 * @param {string} [baseDir] 模块根目录（assembly/sandbox 所在）
 * @param {string} [home] 用户主目录（~/.dsh 所在）
 * @returns {{assemblyDir: string, sandboxRoot: string, profilesRoot: string, storeRoot: string}}
 */
function defaultRoots(baseDir, home) {
  const root = baseDir || path.resolve(__dirname, '..');
  const h = home || os.homedir();
  return {
    assemblyDir: path.join(root, 'assembly'),
    sandboxRoot: path.join(root, 'sandbox', '.sandbox'),
    profilesRoot: path.join(h, '.dsh', 'profiles'),
    storeRoot: path.join(h, '.dsh', 'hotplug-store')
  };
}

module.exports = {
  PACK_ID_RE,
  PLUGIN_NAME_RE,
  EXACT_VERSION_RE,
  RESERVED_WIN_NAMES,
  GITHUB_MIRRORS,
  SCHEMA_VERSION,
  HOTPACK_VERSION,
  MAX_ID_LENGTH,
  MAX_PATCH_ID_LENGTH,
  MAX_SOURCE_PATH_LENGTH,
  RUNLOG_MAX_BYTES,
  LOCK_WAIT_MS,
  LOCK_STALE_MS,
  LOCK_POLL_MS,
  LAUNCH_ALIVE_CHECK_MS,
  LAUNCH_WAIT_TIMEOUT_MS,
  CRASH_LOOP_THRESHOLD,
  CRASH_LOOP_WINDOW_MS,
  DEFAULT_RETRY_BUDGET,
  STATE_FILE,
  RUN_LOG_FILE,
  PATCH_FILE,
  PROFILE_MANIFEST,
  SNAPSHOT_INLINE_MAX_BYTES,
  defaultRoots
};
