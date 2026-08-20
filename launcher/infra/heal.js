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
        // C3 修复：预算语义收紧为 retries >= budget（budget=允许的重试次数上限，
        // 此前 retries > budget 允许 budget+1 次重试，与"不超过预算"文案不符）
        if (!rb.ok || retries >= action.budget) {
          return { ok: false, error: makeError('ERR_HEAL_BUDGET', `${action.code} 重试超过预算（${action.budget}）或回滚失败`), result: { history } };
        }
        continue;
      }
      const verify = await verifyAction(core, action, ctx);
      if (!verify.ok) {
        history.push({ at, code: action.code, action: action.code, verified: false, error: verify.error.message });
        await rollbackAction(core, action, ctx);
        retries += 1;
        if (retries >= action.budget) {
          return { ok: false, error: makeError('ERR_HEAL_BUDGET', `${action.code} 验证失败且重试超过预算（${action.budget}）`), result: { history } };
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
