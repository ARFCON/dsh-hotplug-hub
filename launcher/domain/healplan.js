'use strict';
// domain/healplan.js — 8+1 个自愈动作计划生成（纯函数）
//
// 每个动作包含：触发信号 / 受限动作 / 验证 / 回滚 / 重试预算。
// 自愈不是"写建议"，而是"执行 + 验证 + 回滚"（审计 C 修复）。
//
// C3 修复（契约与实现对齐）：ACTIONS 中的 steps 全部为 infra/heal.js 已实现的
// 真实步骤（此前 restore-lockfile/report-path/redecode 为空实现占位，disable-recent
// 无实现，导致 CRASH_LOOP/INSTALL_FAIL 的"疗效"缺失）；新增 HARNESS_FIX 动作承接
// spawn-error 信号（此前错误映射到 INSTALL_FAIL，重装插件无法修复缺失的 harness）。
const {
  GITHUB_MIRRORS,
  CRASH_LOOP_THRESHOLD,
  DEFAULT_RETRY_BUDGET
} = require('../contracts/constants');

const ACTIONS = {
  BUNDLE_MISCLASSIFY: {
    code: 'BUNDLE_MISCLASSIFY',
    trigger: '仅含 dsh.client 的插件被误塞 dsh.profile.bundles',
    steps: [{ type: 'reclassify-bundles' }],
    verify: '重新解析 YAML 并校验 DSH 配置',
    rollback: '恢复原 bundles 列表',
    budget: 2
  },
  INSTALL_FAIL: {
    code: 'INSTALL_FAIL',
    trigger: 'install 退出码非 0 / node_modules 缺失',
    steps: [{ type: 'reinstall' }],
    verify: '重跑 install 并校验产物（node_modules 存在）',
    rollback: '恢复 lockfile 快照',
    budget: DEFAULT_RETRY_BUDGET
  },
  GITHUB_ACQUIRE_FAIL: {
    code: 'GITHUB_ACQUIRE_FAIL',
    trigger: 'github 源拉取失败',
    steps: [{ type: 'mirror-retry', mirrors: GITHUB_MIRRORS }],
    verify: '目标目录存在且含 package.json',
    rollback: '清理半成品目录',
    budget: GITHUB_MIRRORS.length
  },
  LINK_FAIL: {
    code: 'LINK_FAIL',
    trigger: 'path/github 目标目录不存在',
    steps: [{ type: 'rebuild-link' }],
    verify: 'link 目标存在',
    rollback: '移除坏链接',
    budget: 2
  },
  VERSION_CONFLICT: {
    code: 'VERSION_CONFLICT',
    trigger: '解析期 semver 冲突',
    // 自愈审计修复：去掉 `quarantine` 步骤——executeAction 顺序执行且失败即返回，
    // 使 quarantine 只在 pin-compatible 成功后运行（误隔离健康插件），而 pin-compatible
    // 失败时永不运行（隔离冲突插件的本意落空）。重 pin 成功即无冲突，失败即诚实报错。
    steps: [{ type: 'pin-compatible' }],
    verify: '重跑 resolve 无冲突',
    rollback: '恢复原 pin',
    budget: 2
  },
  CRASH_LOOP: {
    code: 'CRASH_LOOP',
    trigger: `启动后连续 ${CRASH_LOOP_THRESHOLD} 次非零退出`,
    steps: [{ type: 'rollback-snapshot' }, { type: 'disable-recent' }],
    // heal 不重启进程，故"存活时长"由下次 launch 验证；此处以"计数已重置"作为完成判据。
    verify: '最近退出码/计数已重置（回滚+禁用后 fresh start）',
    rollback: '恢复被禁用插件',
    budget: 2
  },
  UTF8_CORRUPTION: {
    code: 'UTF8_CORRUPTION',
    trigger: '日志/配置出现 U+FFFD',
    steps: [{ type: 'regenerate-patch' }],
    verify: '重写后无 U+FFFD',
    rollback: '保留原文件备份',
    budget: 2
  },
  REGISTRY_UNAVAILABLE: {
    code: 'REGISTRY_UNAVAILABLE',
    trigger: 'registry 连接失败/超时',
    // 自愈审计修复：registry（npm）故障用 registry 探测重试，而非 mirror-retry
    // （github 镜像克隆）——此前治 npm 故障却克隆 github 插件，语义错位且无 github
    // 插件时恒失败。
    steps: [{ type: 'reprobe-registry' }],
    verify: 'registry 探测成功',
    rollback: '无（只读探测）',
    budget: DEFAULT_RETRY_BUDGET
  },
  HARNESS_FIX: {
    code: 'HARNESS_FIX',
    trigger: 'harness spawn 失败（ENOENT/损坏 exe）',
    steps: [{ type: 'reprobe-harness' }],
    verify: '重新探测到可信 harness',
    rollback: '无（只读探测）',
    budget: 2
  }
};

/**
 * 由分类结果生成自愈动作计划。
 * M-10 修复（v5 阶段 2）：返回深拷贝 + 冻结的 action 列表——调用方修改
 * action.steps 等字段不得污染 ACTIONS 定义（此前 steps[].mirrors 数组按引用共享）。
 * @param {object|Array<object>} classification classifySignal 产物（单个或列表）
 * @param {object} [context]
 * @param {boolean} [context.dryRun] 默认 true（dry-run 预览）
 * @returns {{ok: boolean, actions: Array<object>}}
 */
function planActions(classification, context = {}) {
  // 审计修复：`context = {}` 只覆盖 undefined；显式传 null 时 context.dryRun 抛
  // TypeError。改为空对象兜底（null/undefined 一视同仁）。
  context = context || {};
  const items = Array.isArray(classification) ? classification : [classification];
  const codes = new Set();
  for (const c of items) {
    if (!c || typeof c !== 'object') continue;
    if (c.action && ACTIONS[c.action]) codes.add(c.action);
    else if (c.code && ACTIONS[c.code]) codes.add(c.code);
  }
  const actions = [...codes].map((code) => ({
    ...deepCopyAction(ACTIONS[code]),
    dryRun: context.dryRun !== false
  }));
  return { ok: true, actions };
}

/**
 * 查询动作定义（M-10：返回深拷贝，调用方修改不影响定义）。
 * @param {string} code
 * @returns {object|null}
 */
function describeAction(code) {
  return ACTIONS[code] ? deepCopyAction(ACTIONS[code]) : null;
}

/** 深拷贝动作定义（steps 数组/镜像列表均复制）。 */
function deepCopyAction(action) {
  return JSON.parse(JSON.stringify(action));
}

/**
 * 全部动作码。
 * @returns {Array<string>}
 */
function allActionCodes() {
  return Object.keys(ACTIONS);
}

// M-10：定义表冻结（浅冻结 + 内层 steps/mirrors 数组冻结）——任何运行时
// 写入（含 Object.assign 到 ACTIONS[code]）在严格模式下抛 TypeError。
function deepFreeze(obj) {
  if (obj && typeof obj === 'object') {
    for (const key of Object.keys(obj)) deepFreeze(obj[key]);
    Object.freeze(obj);
  }
  return obj;
}
deepFreeze(ACTIONS);

module.exports = { ACTIONS, planActions, describeAction, allActionCodes };
