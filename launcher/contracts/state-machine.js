'use strict';
// contracts/state-machine.js — 状态机状态表与转移守卫
// 守卫原则：先校验后副作用（审计 H/F 修复：校验与副作用严格分离）
const { makeError } = require('./errors');

const STATES = {
  IDLE: 'IDLE',
  ASSEMBLED: 'ASSEMBLED',
  RESOLVED: 'RESOLVED',
  CHECKED: 'CHECKED',
  INSTALLED: 'INSTALLED',
  SYNCED: 'SYNCED',
  LAUNCHED: 'LAUNCHED',
  MONITORING: 'MONITORING',
  HEALING: 'HEALING',
  QUARANTINED: 'QUARANTINED',
  ROLLED_BACK: 'ROLLED_BACK',
  FAILED: 'FAILED'
};

// 转移表：{from, to, action, guard}（微转移；命令 = 子流水线，见 COMMAND_PIPELINES）
// T1 修复：移除被 *→FAILED 完全遮蔽的 MONITORING→FAILED 条目、以及与
// HEALING→SYNCED 语义重复的 HEALING→LAUNCHED（手册 3.3.4 状态图只保留
// HEALING→SYNCED；冗余条目会使 transitionInfo 首匹配语义产生歧义）。
const TRANSITIONS = [
  { from: STATES.IDLE, to: STATES.ASSEMBLED, action: 'assemble', guard: 'validate-id' },
  { from: STATES.ASSEMBLED, to: STATES.RESOLVED, action: 'resolve', guard: 'assembly-valid' },
  { from: STATES.RESOLVED, to: STATES.CHECKED, action: 'check', guard: 'no-conflict-error' },
  { from: STATES.CHECKED, to: STATES.INSTALLED, action: 'install', guard: 'conflicts-ok' },
  { from: STATES.INSTALLED, to: STATES.SYNCED, action: 'sync', guard: 'install-ok' },
  { from: STATES.SYNCED, to: STATES.LAUNCHED, action: 'launch', guard: 'harness-verified' },
  { from: STATES.LAUNCHED, to: STATES.MONITORING, action: 'monitor', guard: 'alive-confirmed' },
  { from: STATES.LAUNCHED, to: STATES.SYNCED, action: 'relaunch', guard: 'alive-confirmed' },
  { from: STATES.MONITORING, to: STATES.SYNCED, action: 'relaunch', guard: 'alive-confirmed' },
  { from: STATES.MONITORING, to: STATES.HEALING, action: 'heal', guard: 'exit-nonzero' },
  { from: STATES.HEALING, to: STATES.SYNCED, action: 'relaunch', guard: 'budget-ok' },
  { from: STATES.HEALING, to: STATES.QUARANTINED, action: 'quarantine', guard: 'budget-exceeded' },
  { from: STATES.HEALING, to: STATES.ROLLED_BACK, action: 'rollback', guard: 'verify-failed' },
  { from: STATES.QUARANTINED, to: STATES.INSTALLED, action: 'install', guard: 'conflicts-ok' },
  { from: STATES.ROLLED_BACK, to: STATES.INSTALLED, action: 'install', guard: 'conflicts-ok' },
  { from: STATES.FAILED, to: STATES.IDLE, action: 'reset', guard: 'idle' },
  // 命令级通配：重新组装 / 自愈 / 回滚允许从任意状态进入（先于 *→FAILED 匹配）
  { from: '*', to: STATES.ASSEMBLED, action: 'reassemble', guard: 'rebuild-ok' },
  { from: '*', to: STATES.HEALING, action: 'heal-any', guard: 'classify-signals' },
  { from: '*', to: STATES.ROLLED_BACK, action: 'rollback-any', guard: 'snapshot-available' },
  { from: '*', to: STATES.FAILED, action: 'fail', guard: 'error' }
];

// 命令 = 子流水线：微转移链 + 落点
const COMMAND_PIPELINES = {
  assemble: { chain: [STATES.ASSEMBLED, STATES.RESOLVED, STATES.CHECKED], landing: STATES.CHECKED },
  install: { chain: [STATES.INSTALLED], landing: STATES.INSTALLED },
  launch: { chain: [STATES.SYNCED, STATES.LAUNCHED, STATES.MONITORING], landing: STATES.MONITORING },
  heal: { chain: [STATES.HEALING], landing: STATES.HEALING },
  rollback: { chain: [STATES.ROLLED_BACK], landing: STATES.ROLLED_BACK }
};

const GUARD_DESCRIPTIONS = {
  'validate-id': 'id 必须通过白名单校验且无路径穿越',
  'assembly-valid': 'assembly 必须通过 hotpack 1.0 校验',
  'no-conflict-error': '解析结果不得含 error 级冲突',
  'conflicts-ok': '冲突矩阵通过',
  'install-ok': '安装产物（node_modules）必须落地',
  'harness-verified': 'harness 必须存在且通过完整性校验',
  'alive-confirmed': '子进程存活确认成功',
  'exit-nonzero': '子进程非零退出',
  'budget-ok': '自愈重试预算未超限',
  'budget-exceeded': '自愈重试预算超限',
  'verify-failed': '自愈验证失败',
  'error': '任一步骤出错',
  'rebuild-ok': '允许从任意状态重新组装（幂等重建）',
  'classify-signals': '允许从任意状态执行自愈（基于结构化日志）',
  'snapshot-available': '允许从任意状态回滚（须存在快照）',
  'idle': '回到初始态（重新开始）'
};

/**
 * 判断是否存在合法转移。
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
function canTransition(from, to) {
  return TRANSITIONS.some((t) => (t.from === from || t.from === '*') && t.to === to);
}

/**
 * 查询转移信息。
 * @param {string} from
 * @param {string} to
 * @returns {object|null}
 */
function transitionInfo(from, to) {
  return TRANSITIONS.find((t) => (t.from === from || t.from === '*') && t.to === to) || null;
}

/**
 * 断言转移合法；同状态视为幂等重入（允许重复执行）。
 * @param {string} from
 * @param {string} to
 * @param {string} [action]
 * @returns {{ok: boolean, info?: object, error?: Error}}
 */
function assertTransition(from, to, action) {
  if (from === to) return { ok: true, info: { from, to, action, guard: 'idempotent' } };
  const info = transitionInfo(from, to);
  if (!info) {
    return {
      ok: false,
      error: makeError('ERR_ENV_UNSUPPORTED', `非法状态转移 ${from} → ${to}（action=${action || '?'}）`)
    };
  }
  return { ok: true, info };
}

/**
 * 是否为终止态。
 * @param {string} state
 * @returns {boolean}
 */
function isTerminal(state) {
  return state === STATES.FAILED || state === STATES.QUARANTINED || state === STATES.ROLLED_BACK;
}

/**
 * 按 action 推导目标状态（用于命令完成后的 phase 更新）。
 * @param {string} action
 * @param {string} current
 * @returns {string|null}
 */
function nextStateFor(action, current) {
  const t = TRANSITIONS.find((x) => x.action === action && (x.from === current || x.from === '*'));
  return t ? t.to : null;
}

/**
 * 断言命令级子流水线合法：从当前状态沿链逐跳校验（QA 修复：落点与转移表一致）。
 * 命令 = 子流水线（如 assemble = ASSEMBLED→RESOLVED→CHECKED，落 CHECKED）。
 * T1 修复：未知命令显式报错（此前返回 ok:true，未知命令被静默放行）。
 * @param {string} current 当前 phase
 * @param {string} command assemble|install|launch|heal|rollback
 * @returns {{ok: boolean, info?: object, error?: Error}}
 */
function assertCommandPipeline(current, command) {
  const pipeline = COMMAND_PIPELINES[command];
  if (!pipeline) {
    return {
      ok: false,
      error: makeError('ERR_ARG_UNKNOWN_COMMAND', `未知命令：${command}`)
    };
  }
  let from = current;
  for (const to of pipeline.chain) {
    if (from === to) continue; // 幂等重入
    const info = transitionInfo(from, to);
    if (!info) {
      return {
        ok: false,
        error: makeError('ERR_ENV_UNSUPPORTED', `非法状态转移 ${from} → ${to}（command=${command}，需先执行前置命令）`)
      };
    }
    from = to;
  }
  return { ok: true, info: { from: current, command, chain: pipeline.chain, landing: pipeline.landing } };
}

module.exports = {
  STATES,
  TRANSITIONS,
  COMMAND_PIPELINES,
  GUARD_DESCRIPTIONS,
  canTransition,
  transitionInfo,
  assertTransition,
  assertCommandPipeline,
  isTerminal,
  nextStateFor
};
