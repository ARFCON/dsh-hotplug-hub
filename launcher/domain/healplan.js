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
    steps: [{ type: 'pin-compatible' }, { type: 'quarantine' }],
    verify: '重跑 resolve 无冲突',
    rollback: '恢复原 pin',
    budget: 2
  },
  CRASH_LOOP: {
    code: 'CRASH_LOOP',
    trigger: `启动后 ${CRASH_LOOP_THRESHOLD} 次在窗口内崩溃`,
    steps: [{ type: 'rollback-snapshot' }, { type: 'disable-recent' }],
    verify: '重启后存活时间显著增加',
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
    steps: [{ type: 'mirror-retry', mirrors: GITHUB_MIRRORS }],
    verify: 'registry 探测成功',
    rollback: '恢复原 registry 配置',
    budget: GITHUB_MIRRORS.length
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
 * @param {object|Array<object>} classification classifySignal 产物（单个或列表）
 * @param {object} [context]
 * @param {boolean} [context.dryRun] 默认 true（dry-run 预览）
 * @returns {{ok: boolean, actions: Array<object>}}
 */
function planActions(classification, context = {}) {
  const items = Array.isArray(classification) ? classification : [classification];
  const codes = new Set();
  for (const c of items) {
    if (!c || typeof c !== 'object') continue;
    if (c.action && ACTIONS[c.action]) codes.add(c.action);
    else if (c.code && ACTIONS[c.code]) codes.add(c.code);
  }
  const actions = [...codes].map((code) => ({
    ...ACTIONS[code],
    dryRun: context.dryRun !== false
  }));
  return { ok: true, actions };
}

/**
 * 查询动作定义。
 * @param {string} code
 * @returns {object|null}
 */
function describeAction(code) {
  return ACTIONS[code] || null;
}

/**
 * 全部动作码。
 * @returns {Array<string>}
 */
function allActionCodes() {
  return Object.keys(ACTIONS);
}

module.exports = { ACTIONS, planActions, describeAction, allActionCodes };
