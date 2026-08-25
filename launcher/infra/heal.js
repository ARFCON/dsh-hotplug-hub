'use strict';
// infra/heal.js — 自愈编排：执行 + 验证 + 回滚 + 重试预算（runHeal）
//
// 审计修复：C（自愈不是"写建议"，是"执行 + 验证 + 回滚"）、
// N33（损坏/缺失 state 禁止覆盖）、N34（heal 结果被后续命令保留）。
// 步骤落地（executeAction/verifyAction/rollbackAction）见 infra/heal-steps.js。
const { makeError } = require('../contracts/errors');
const { planActions } = require('../domain/healplan');
const { executeAction } = require('./heal-steps');
const { verifyAction, rollbackAction } = require('./heal-verify');

/**
 * 执行自愈计划（执行 + 验证 + 回滚 + 预算）。
 * @param {object} core
 * @param {Array<object>} actions planActions 产物
 * @param {object} ctx { state, profile, plugins, quarantine, onMirror }
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun]
 * @returns {Promise<{ok: boolean, result?: object, error?: Error}>}
 */
async function runHeal(core, actions, ctx, opts = {}) {
  const dryRun = opts.dryRun === true;
  const history = [];
  for (const action of actions || []) {
    let retries = 0;
    let done = false;
    while (!done) {
      const at = core.ports.now.iso();
      if (dryRun) {
        history.push({ at, code: action.code, action: action.code, dryRun: true, verified: false });
        done = true;
        break;
      }
      const exec = await executeAction(core, action, ctx);
      if (!exec.ok) {
        history.push({ at, code: action.code, action: action.code, verified: false, error: exec.error.message });
        const rb = await rollbackAction(core, action, ctx);
        retries += 1;
        // H1 修复：budget = 允许的重试次数上限——首次失败后 retries=1，须 `retries > budget`
        // 才超限（budget=1 → 1 次重试=2 次总尝试；budget=0 → 0 次重试=1 次总尝试）。
        // 此前 `retries >= budget` 使 budget=0 与 budget=1 行为不可区分（off-by-one）。
        if (!rb.ok || retries > action.budget) {
          return { ok: false, error: makeError('ERR_HEAL_BUDGET', `${action.code} 重试超过预算（${action.budget}）或回滚失败`), result: { history } };
        }
        continue;
      }
      const verify = await verifyAction(core, action, ctx);
      if (!verify.ok) {
        history.push({ at, code: action.code, action: action.code, verified: false, error: verify.error.message });
        // 自愈审计修复：回滚失败在此前被忽略（verify 失败路径仍继续重试），
        // 回滚失败意味着当前状态已不可信，须与 exec 失败路径一致地视为终止。
        const rb = await rollbackAction(core, action, ctx);
        retries += 1;
        if (!rb.ok || retries > action.budget) {
          return { ok: false, error: makeError('ERR_HEAL_BUDGET', `${action.code} 验证失败且（回滚失败或重试超过预算 ${action.budget}）`), result: { history } };
        }
        continue;
      }
      history.push({ at, code: action.code, action: action.code, verified: true });
      done = true;
    }
  }
  return { ok: true, result: { history, actionCount: actions.length } };
}

module.exports = { runHeal, executeAction, verifyAction, rollbackAction, planActions };
