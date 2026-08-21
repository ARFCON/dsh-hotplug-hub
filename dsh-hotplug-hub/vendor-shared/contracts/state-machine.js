'use strict';
// contracts/state-machine.js — 状态机状态表与转移守卫
// 守卫原则：先校验后副作用（审计 H/F 修复：校验与副作用严格分离）
//
// v5 阶段 2 定向修复（M-24/25/35/36 + R-v5-20）：
//   - M-24：删除 `*→HEALING` / `*→ROLLED_BACK` 通配——IDLE/ASSEMBLED/RESOLVED/CHECKED
//     不得直接 heal/rollback；补充显式合法入口（LAUNCHED→HEALING 崩溃自愈、
//     INSTALLED/SYNCED/LAUNCHED/MONITORING/QUARANTINED/FAILED→ROLLED_BACK 回滚）；
//   - M-36：非法状态转移使用专属错误码 ERR_ARG_BAD_STATE（exit=2），不再复用
//     ERR_ENV_UNSUPPORTED（exit=12 误导为环境故障）；
//   - R-v5-20：删除 nextStateFor、COMMAND_PIPELINES.landing 与
//     canTransition/assertTransition/isTerminal 装饰函数（消除 M-25/M-35 语义矛盾根源）；
//     assertCommandPipeline 只校验 chain；phase 落点由阶段代码自行定
//     （wait=LAUNCHED / detach=MONITORING）。
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
// M-24 修复（v5 阶段 2）：heal/rollback 不再通配——只允许显式合法入口；
// `*→ASSEMBLED`（幂等重建）与 `*→FAILED`（错误兜底）通配保留。
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
  // M-24：heal 显式合法入口——已进入安装/同步/启动域的状态（含崩溃后 INSTALLED
  // 未及变更 phase 的形态）；IDLE 及组装期（ASSEMBLED/RESOLVED/CHECKED）拒绝
  { from: STATES.INSTALLED, to: STATES.HEALING, action: 'heal', guard: 'exit-nonzero' },
  { from: STATES.SYNCED, to: STATES.HEALING, action: 'heal', guard: 'exit-nonzero' },
  { from: STATES.LAUNCHED, to: STATES.HEALING, action: 'heal', guard: 'exit-nonzero' },
  { from: STATES.QUARANTINED, to: STATES.HEALING, action: 'heal', guard: 'exit-nonzero' },
  { from: STATES.ROLLED_BACK, to: STATES.HEALING, action: 'heal', guard: 'exit-nonzero' },
  { from: STATES.FAILED, to: STATES.HEALING, action: 'heal', guard: 'exit-nonzero' },
  { from: STATES.HEALING, to: STATES.SYNCED, action: 'relaunch', guard: 'budget-ok' },
  { from: STATES.HEALING, to: STATES.QUARANTINED, action: 'quarantine', guard: 'budget-exceeded' },
  { from: STATES.HEALING, to: STATES.ROLLED_BACK, action: 'rollback', guard: 'verify-failed' },
  { from: STATES.QUARANTINED, to: STATES.INSTALLED, action: 'install', guard: 'conflicts-ok' },
  { from: STATES.ROLLED_BACK, to: STATES.INSTALLED, action: 'install', guard: 'conflicts-ok' },
  { from: STATES.FAILED, to: STATES.IDLE, action: 'reset', guard: 'idle' },
  // M-24：rollback 命令显式合法入口（已进入安装/同步/启动域的状态；IDLE 及组装期拒绝）
  { from: STATES.INSTALLED, to: STATES.ROLLED_BACK, action: 'rollback', guard: 'snapshot-available' },
  { from: STATES.SYNCED, to: STATES.ROLLED_BACK, action: 'rollback', guard: 'snapshot-available' },
  { from: STATES.LAUNCHED, to: STATES.ROLLED_BACK, action: 'rollback', guard: 'snapshot-available' },
  { from: STATES.MONITORING, to: STATES.ROLLED_BACK, action: 'rollback', guard: 'snapshot-available' },
  { from: STATES.QUARANTINED, to: STATES.ROLLED_BACK, action: 'rollback', guard: 'snapshot-available' },
  { from: STATES.FAILED, to: STATES.ROLLED_BACK, action: 'rollback', guard: 'snapshot-available' },
  // 命令级通配：重新组装允许从任意状态进入（幂等重建，先于 *→FAILED 匹配）
  { from: '*', to: STATES.ASSEMBLED, action: 'reassemble', guard: 'rebuild-ok' },
  { from: '*', to: STATES.FAILED, action: 'fail', guard: 'error' }
];

// 命令 = 子流水线：微转移链（R-v5-20：删除 landing——phase 落点由阶段代码自行定）
const COMMAND_PIPELINES = {
  assemble: { chain: [STATES.ASSEMBLED, STATES.RESOLVED, STATES.CHECKED] },
  install: { chain: [STATES.INSTALLED] },
  launch: { chain: [STATES.SYNCED, STATES.LAUNCHED, STATES.MONITORING] },
  heal: { chain: [STATES.HEALING] },
  rollback: { chain: [STATES.ROLLED_BACK] }
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
  'snapshot-available': '回滚须存在快照（仅已进入安装/同步/启动域的状态）',
  'idle': '回到初始态（重新开始）'
};

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
 * 断言命令级子流水线合法：从当前状态沿链逐跳校验（QA 修复：落点与转移表一致）。
 * 命令 = 子流水线（如 assemble = ASSEMBLED→RESOLVED→CHECKED）。
 * T1 修复：未知命令显式报错（此前返回 ok:true，未知命令被静默放行）。
 * M-36 修复：非法状态转移使用专属错误码 ERR_ARG_BAD_STATE（exit=2）。
 * R-v5-20：只校验 chain，不返回 landing。
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
        error: makeError('ERR_ARG_BAD_STATE', `非法状态转移 ${from} → ${to}（command=${command}，需先执行前置命令）`)
      };
    }
    from = to;
  }
  return { ok: true, info: { from: current, command, chain: pipeline.chain } };
}

module.exports = {
  STATES,
  TRANSITIONS,
  COMMAND_PIPELINES,
  GUARD_DESCRIPTIONS,
  transitionInfo,
  assertCommandPipeline
};
