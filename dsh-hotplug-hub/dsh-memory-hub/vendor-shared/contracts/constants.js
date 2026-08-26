'use strict';
// contracts/constants.js — 统一常量：路径 / 正则 / 镜像 / 预算（纯数据，零副作用）
const path = require('path');
const os = require('os');

// --- 正则（与既有 PACK_ID_RE / PLUGIN_NAME_RE / EXACT_VERSION_RE 保持一致）---
const PACK_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const PLUGIN_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
// GitHub 仓库 owner/repo 格式：两段、各段字母数字开头（拒绝前导 . - 与 .. 段，
// 防止 repo 进入 URL/git clone 时产生路径穿越或畸形 URL）。
const REPO_RE = /^[0-9A-Za-z][0-9A-Za-z._-]*\/[0-9A-Za-z][0-9A-Za-z._-]*$/;

// Windows 保留设备名（N43：CON/NUL/COM1… 全部拒绝）
const RESERVED_WIN_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
]);

// GitHub 镜像源「契约主集」（3 个，R-v5-5：prototype/市场的 +3 为原型实验源，
// 不进契约；产品侧扩展源在本模块之外以本地常量声明并标注）
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

// 文件锁（30s 过期接管 / 10s 等待 / 100ms 轮询 / 10s 刷新）
const LOCK_WAIT_MS = 10000;
const LOCK_STALE_MS = 30000;
const LOCK_POLL_MS = 100;
const LOCK_REFRESH_MS = 10000;

// 启动生命周期（detach 存活确认窗口；--wait 默认超时）
const LAUNCH_ALIVE_CHECK_MS = 500;
const LAUNCH_WAIT_TIMEOUT_MS = 120000;

// 崩溃循环判定：连续 CRASH_LOOP_THRESHOLD 次非零退出（retries 连续失败计数，
// 成功即清零；与 classifyStateSignals / healplan 触发文案一致）。历史曾声明
// "30s 窗口"语义（CRASH_LOOP_WINDOW_MS），但从未被实现或消费——已删除该死常量。
const CRASH_LOOP_THRESHOLD = 3;

// 自愈默认重试预算
const DEFAULT_RETRY_BUDGET = 3;

// 产物文件名
const STATE_FILE = 'state.json';
const RUN_LOG_FILE = 'run.jsonl';
const PATCH_FILE = 'cordis.patch.yml';
const PROFILE_MANIFEST = 'package.json';

// 快照单文件体积上限（超过则只记哈希、内容走 .bak 目录）
const SNAPSHOT_INLINE_MAX_BYTES = 1024 * 1024;

// --- 根域后缀常量（R-v5-4：常量名不再叫 DSH_*_ROOT，改后缀语义 + 单一解析函数）---
// dshRoot（.dsh 域目录）下的子目录名
const PROFILES_DIR = 'profiles';
const STORE_DIR = 'hotplug-store';
const MEMORY_DIR = 'memory-hub';
const HOTPLUG_DIR = 'hotplug-hub';

// cordis.patch.yml 四写者（launcher/hotplug/dseam/C#）共用的锁文件名（CONTRACT.md 钉死）
const PATCH_LOCK_FILE = '.dsh-patch.lock';

/**
 * 解析 DSH 根域（H-1 修复的单一真源；CONTRACT.md 钉死）。
 *
 * 优先级：DSH_HOTPLUG_ROOT > DSH_HOME > ~/.dsh
 *   - DSH_HOTPLUG_ROOT 设定时（launcher 隔离根语义），整个根域（home/profiles/
 *     store/memory/hotplug）落其下：dshRoot = <root>/.dsh，home 推导为 <root>；
 *   - DSH_HOME 指向 .dsh 域目录本身（harness 语义），home = dirname(dshRoot)；
 *   - 缺省：<homedir>/.dsh。
 *
 * @param {object} [env] 环境变量（默认 process.env；传 {} 表示「无任何环境变量」→ 回落 ~/.dsh）
 * @returns {{home: string, dshRoot: string}} 根域结果（子目录经 dshRootPaths 派生）
 */
function resolveDshRoot(env = process.env) {
  const hotplugRootEnv = typeof env.DSH_HOTPLUG_ROOT === 'string' ? env.DSH_HOTPLUG_ROOT.trim() : '';
  if (hotplugRootEnv !== '') {
    const base = path.resolve(hotplugRootEnv);
    return { home: base, dshRoot: path.join(base, '.dsh') };
  }
  const dshHome = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  if (dshHome !== '') {
    const dshRoot = path.resolve(dshHome);
    return { home: path.dirname(dshRoot), dshRoot };
  }
  const home = os.homedir();
  return { home, dshRoot: path.join(home, '.dsh') };
}

/**
 * 由 resolveDshRoot 结果派生各子目录（全部基于 dshRoot，禁止另行拼接 home）。
 * @param {{home: string, dshRoot: string}} root resolveDshRoot 产物
 * @returns {{profilesDir: string, storeDir: string, memoryDir: string, hotplugDir: string}}
 */
function dshRootPaths(root) {
  return {
    profilesDir: path.join(root.dshRoot, PROFILES_DIR),
    storeDir: path.join(root.dshRoot, STORE_DIR),
    memoryDir: path.join(root.dshRoot, MEMORY_DIR),
    hotplugDir: path.join(root.dshRoot, HOTPLUG_DIR)
  };
}

/**
 * 计算默认根目录（launcher 历史入口；新代码统一走 resolveDshRoot + dshRootPaths）。
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
  REPO_RE,
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
  LOCK_REFRESH_MS,
  LAUNCH_ALIVE_CHECK_MS,
  LAUNCH_WAIT_TIMEOUT_MS,
  CRASH_LOOP_THRESHOLD,
  DEFAULT_RETRY_BUDGET,
  STATE_FILE,
  RUN_LOG_FILE,
  PATCH_FILE,
  PROFILE_MANIFEST,
  SNAPSHOT_INLINE_MAX_BYTES,
  PROFILES_DIR,
  STORE_DIR,
  MEMORY_DIR,
  HOTPLUG_DIR,
  PATCH_LOCK_FILE,
  resolveDshRoot,
  dshRootPaths,
  defaultRoots
};
