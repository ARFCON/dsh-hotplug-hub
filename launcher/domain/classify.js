'use strict';
// domain/classify.js — 结构化信号错误分类（无宽正则）
//
// 审计修复：J（宽正则误判正常日志）— 不再对任意日志行做无锚定匹配；
// 只接受结构化信号 {kind, ...}，且 stderr/log 规则全部锚定行首 Error: 前缀。
const { GITHUB_MIRRORS, CRASH_LOOP_THRESHOLD } = require('../contracts/constants');

// UTF-8 损坏信号的机器可识别标记（monitor/stages 写入 run.jsonl error 流时携带；
// classify 据此识别——与 U+FFFD 内容检测互补，同一真源，杜绝"检测到却不识别"脱钩）。
// 带方括号以区别于用户日志中普通提及 "UTF8_CORRUPTION" 词的情形。
const UTF8_CORRUPTION_MARKER = '[UTF8_CORRUPTION]';

// stderr 错误行规则：全部锚定 /^Error:/ 前缀，杜绝 INFO/AUTH/401 等正常内容误报
const STREAM_RULES = [
  {
    code: 'LINK_FAIL',
    action: 'LINK_FAIL',
    suggest: '检查本地路径或链接',
    test: (line) => /^Error:\s*ENOENT(?:\s|:|$)/.test(line)
  },
  {
    code: 'REGISTRY_UNAVAILABLE',
    action: 'REGISTRY_UNAVAILABLE',
    suggest: `换镜像源重试：${GITHUB_MIRRORS.join(' / ')}`,
    test: (line) => /^Error:\s*(?:ETIMEDOUT|ENOTFOUND|ECONNREFUSED)(?:\s|:|$)/.test(line)
  },
  {
    code: 'INSTALL_FAIL',
    action: 'INSTALL_FAIL',
    suggest: '检查目录权限后重装',
    test: (line) => /^Error:\s*EACCES(?:\s|:|$)/.test(line)
  },
  {
    code: 'GITHUB_ACQUIRE_FAIL',
    action: 'GITHUB_ACQUIRE_FAIL',
    suggest: '检查仓库地址或镜像源',
    // 真实 git clone 失败以 fatal:/remote: 开头（无 Error: 前缀）；仅匹配 git 语义行，避免
    // 'fatal: something user-level' 之类用户日志误报（QA3 故障全命中 / 零误报回归）。
    // C3 修复：`fatal: unable to access` 必须带引号 URL（真实 git 输出形态），
    // 杜绝应用自身日志『fatal: unable to access config』类误报。
    test: (line) => /^Error:\s*Repository not found/.test(line) ||
      /^fatal:\s*unable to access\s+'https?:\/\/[^']*'/.test(line) ||
      /^fatal:\s*could not read Username for\s+'https?:\/\/[^']*'/.test(line) ||
      /^remote:\s*Repository not found/.test(line)
  }
];

/** 是否为 UTF-8 损坏信号（机器标记或 U+FFFD 替换符）。 */
function isCorruptionLine(line) {
  return line.includes(UTF8_CORRUPTION_MARKER) || line.includes('\uFFFD');
}

/**
 * 结构化信号分类。
 * 支持信号：
 *   {kind:'spawn-error', err:Error}          — spawn 双形态错误（N 修复）
 *   {kind:'exit', exitCode:number}           — 子进程退出
 *   {kind:'stderr', line:string}             — 单条 stderr 行（须锚定 Error: 前缀）
 *   {kind:'log', severity:string, message:string} — 结构化日志条目
 * @param {object} signal
 * @returns {{code: string, action: string, suggest: string}|null}
 */
function classifySignal(signal) {
  if (!signal || typeof signal !== 'object') return null;
  switch (signal.kind) {
    case 'spawn-error': {
      const c = signal.err && signal.err.code;
      if (c === 'ENOENT') {
        // C3 修复：harness 缺失归因于 harness 而非插件安装（INSTALL_FAIL 只重装插件，
        // 无法修复缺失的 dsh 可执行文件）——映射独立动作 HARNESS_FIX。
        return { code: 'ERR_LAUNCH_SPAWN', action: 'HARNESS_FIX', suggest: '可执行文件不存在，检查安装或 PATH' };
      }
      // 审计修复：EACCES/EPERM（权限不足）此前一律归 HARNESS_FIX——reprobe-harness
      // 无法修复权限类错误，正确动作是 INSTALL_FAIL（检查目录权限/重装）。
      if (c === 'EACCES' || c === 'EPERM') {
        return { code: 'ERR_LAUNCH_SPAWN', action: 'INSTALL_FAIL', suggest: '可执行文件权限不足，检查目录权限后重试' };
      }
      return { code: 'ERR_LAUNCH_SPAWN', action: 'HARNESS_FIX', suggest: `spawn 失败：${(signal.err && signal.err.message) || '未知错误'}` };
    }
    case 'exit': {
      // 审计修复：exitCode 为 null/undefined 时应视为"无信号"（与 classifyStateSignals
      // 将 lastExit===null 视为无信号一致），而非 `null !== 0` 被误判为非零退出。
      // H5 修复：仅「类型为 number 且有限非零」才触发崩溃循环——字符串 '0'/'1'/''、
      // 布尔 true、数组 [1]、NaN 等一切非规范形态一律视为无信号。此前用 Number() 强转，
      // Number(true)===1 / Number('1')===1 / Number([1])===1 都是有限非零，把「可强转为
      // 非零的非数字」误判为崩溃（严格不等 '0'!==0 只修了强转为 0 的形态）。
      const code = signal.exitCode;
      if (typeof code === 'number' && Number.isFinite(code) && code !== 0) {
        return { code: 'ERR_LAUNCH_EXIT', action: 'CRASH_LOOP', suggest: '启动后非零退出，检查 run.jsonl 日志' };
      }
      return null;
    }
    case 'stderr': {
      const line = String(signal.line || '');
      // 审计修复：stderr 输出含 U+FFFD 同样触发 UTF8_CORRUPTION（此前仅 error 流
      // 检测，子进程自身输出损坏字节到 stderr 时被漏判）。
      if (isCorruptionLine(line)) {
        return { code: 'ERR_LOG_WRITE', action: 'UTF8_CORRUPTION', suggest: '检测到 UTF-8 损坏（U+FFFD），重新解码或重建产物' };
      }
      for (const rule of STREAM_RULES) {
        if (rule.test(line)) return { code: rule.code, action: rule.action, suggest: rule.suggest };
      }
      return null; // 零误报：无锚定匹配不分类
    }
    case 'log': {
      if (signal.severity !== 'error') return null;
      const line = String(signal.message || '');
      if (isCorruptionLine(line)) {
        return { code: 'ERR_LOG_WRITE', action: 'UTF8_CORRUPTION', suggest: '检测到 UTF-8 损坏（U+FFFD），重新解码或重建产物' };
      }
      for (const rule of STREAM_RULES) {
        if (rule.test(line)) return { code: rule.code, action: rule.action, suggest: rule.suggest };
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * 对 run.jsonl 条目列表做批量分类（保留顺序、去重 action）。
 * @param {Array<object>} entries runlog 条目 {stream, line, ...}
 * @returns {Array<{code:string, action:string, suggest:string}>}
 */
function classifyEntries(entries) {
  const seen = new Set();
  const out = [];
  for (const e of entries || []) {
    const sig = e.stream === 'stderr'
      ? { kind: 'stderr', line: e.line }
      : e.stream === 'error'
        ? { kind: 'log', severity: 'error', message: e.line }
        : null;
    if (!sig) continue;
    const cls = classifySignal(sig);
    if (cls && !seen.has(cls.action)) {
      seen.add(cls.action);
      out.push(cls);
    }
  }
  return out;
}

/**
 * 崩溃循环单一真源谓词（D2 修复）：stageStatus 与 classifyStateSignals 共用同一
 * 判定，杜绝两处独立复制导致的漏判/误判漂移。
 *
 * 语义（与 healplan.CRASH_LOOP 触发文案一致）：连续 CRASH_LOOP_THRESHOLD 次非零
 * 退出（retries 计数，成功即清零）即判定崩溃循环；不依赖时间窗口、不依赖 phase。
 * 与 spawn 失败（spawnCode 存在）互斥——子进程从未启动属 HARNESS_FIX/INSTALL_FAIL。
 *
 * @param {object} state 当前 state（含 launch.lastExit/retries/spawnCode）
 * @returns {boolean}
 */
function isCrashLooping(state) {
  const launch = state && state.launch;
  if (!launch) return false;
  if (launch.spawnCode) return false; // spawn 失败与崩溃循环互斥（无退出码）
  const lastExit = launch.lastExit;
  // 与 classifySignal('exit') 同一判定：仅「类型为 number 且有限非零」才算崩溃——
  // Number() 强转会把 true/'1'/[1] 等非规范形态强转为非零误判（H5 同源缺陷）。
  if (typeof lastExit !== 'number' || !Number.isFinite(lastExit) || lastExit === 0) return false; // detach 存活/成功退出/非数字均非崩溃
  return (launch.retries || 0) >= CRASH_LOOP_THRESHOLD;
}

/**
 * 基于 state.launch 的状态驱动分类（C3 修复：CRASH_LOOP 真实可达）。
 *
 * 背景：classifyEntries 只能从行式日志产生 stderr/log 信号，进程退出码从不写入
 * run.jsonl，导致 CRASH_LOOP 在 heal 链路上永远不可达。本函数把 state.launch 的
 * 退出信息合成结构化信号：
 *   - lastExit 非 0：若 retries 达到 CRASH_LOOP_THRESHOLD（连续失败计数，成功即清零）
 *     → CRASH_LOOP（动作触发）；
 *   - 否则返回 null（单次崩溃不足，由调用方决定是否等待更多证据）。
 *
 * 语义（与 healplan.CRASH_LOOP 触发文案一致）：连续 CRASH_LOOP_THRESHOLD 次
 * 非零退出（retries 计数）即判定崩溃循环；不依赖时间窗口。
 *
 * @param {object} state 当前 state（含 launch.lastExit/retries）
 * @returns {Array<{code:string, action:string, suggest:string}>}
 */
function classifyStateSignals(state) {
  const out = [];
  const launch = state && state.launch;
  if (!launch) return out;
  // HARNESS_FIX/INSTALL_FAIL 可达性（契约统一）：spawn 失败（ERR_LAUNCH_SPAWN 的
  // 底层 code）此前不落 state，heal 无法分类——stageLaunch 失败路径现持久化
  // launch.spawnCode，此处复用 classifySignal 的 spawn-error 分支，使 HARNESS_FIX
  // 动作从真实信号可达（ENOENT=harness 缺失，EACCES/EPERM=权限不足）。
  if (launch.spawnCode) {
    const cls = classifySignal({ kind: 'spawn-error', err: { code: launch.spawnCode, message: launch.spawnCode } });
    if (cls) out.push(cls);
    return out; // spawn 失败与崩溃循环互斥：无退出码，不应叠加 CRASH_LOOP
  }
  if (isCrashLooping(state)) {
    out.push({
      code: 'ERR_LAUNCH_EXIT',
      action: 'CRASH_LOOP',
      suggest: `启动后 ${launch.retries} 次非零退出（最近 ${launch.lastExit}），疑似崩溃循环，建议回滚快照或禁用最近插件`
    });
  }
  return out;
}

module.exports = { classifySignal, classifyEntries, classifyStateSignals, isCrashLooping, STREAM_RULES, UTF8_CORRUPTION_MARKER };
