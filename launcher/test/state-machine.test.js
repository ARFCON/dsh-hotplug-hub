'use strict';
// test/state-machine.test.js — 命令级子流水线与转移表一致性（QA 观察 #5 + v5 M-24/36/R-v5-20）
const {
  STATES,
  COMMAND_PIPELINES,
  TRANSITIONS,
  assertCommandPipeline,
  transitionInfo
} = require('../contracts/state-machine');

describe('contracts/state-machine 命令级流水线（QA #5 回归 + v5 定向修复）', () => {
  it('assemble：IDLE 可入；可从任意状态重建（*→ASSEMBLED 通配保留）', () => {
    const r = assertCommandPipeline(STATES.IDLE, 'assemble');
    expect(r.ok).toBe(true);
    // R-v5-20：不再返回 landing
    expect(r.info.landing).toBeUndefined();
    for (const s of Object.values(STATES)) {
      const rr = assertCommandPipeline(s, 'assemble');
      expect(rr.ok, `assemble from=${s}`).toBe(true);
    }
  });

  it('install：需先 assemble（IDLE 拒绝、CHECKED 通过）', () => {
    expect(assertCommandPipeline(STATES.IDLE, 'install').ok).toBe(false);
    expect(assertCommandPipeline(STATES.CHECKED, 'install').ok).toBe(true);
  });

  it('launch：需先 install（CHECKED 拒绝、INSTALLED 通过、幂等重入）', () => {
    expect(assertCommandPipeline(STATES.CHECKED, 'launch').ok).toBe(false);
    expect(assertCommandPipeline(STATES.INSTALLED, 'launch').ok).toBe(true);
    expect(assertCommandPipeline(STATES.LAUNCHED, 'launch').ok).toBe(true); // 幂等
  });

  it('M-24：heal/rollback 只允许显式入口（IDLE 及组装期拒绝，专属码 ERR_ARG_BAD_STATE）', () => {
    // 显式合法入口（已进入安装/同步/启动域）
    for (const s of [STATES.INSTALLED, STATES.SYNCED, STATES.LAUNCHED, STATES.MONITORING, STATES.QUARANTINED, STATES.ROLLED_BACK, STATES.FAILED]) {
      expect(assertCommandPipeline(s, 'heal').ok, `heal from=${s}`).toBe(true);
    }
    for (const s of [STATES.INSTALLED, STATES.SYNCED, STATES.LAUNCHED, STATES.MONITORING, STATES.QUARANTINED, STATES.FAILED]) {
      expect(assertCommandPipeline(s, 'rollback').ok, `rollback from=${s}`).toBe(true);
    }
    // 非法入口（IDLE/ASSEMBLED/RESOLVED/CHECKED）→ ERR_ARG_BAD_STATE（exit=2）
    for (const s of [STATES.IDLE, STATES.ASSEMBLED, STATES.RESOLVED, STATES.CHECKED]) {
      const h = assertCommandPipeline(s, 'heal');
      expect(h.ok, `heal from=${s}`).toBe(false);
      expect(h.error.code).toBe('ERR_ARG_BAD_STATE');
      expect(h.error.exitCode).toBe(2);
      const rb = assertCommandPipeline(s, 'rollback');
      expect(rb.ok, `rollback from=${s}`).toBe(false);
      expect(rb.error.code).toBe('ERR_ARG_BAD_STATE');
    }
  });

  it('COMMAND_PIPELINES 每条链的微转移都存在于转移表（R-v5-20：无 landing）', () => {
    const pre = { assemble: STATES.IDLE, install: STATES.CHECKED, launch: STATES.INSTALLED, heal: STATES.MONITORING, rollback: STATES.INSTALLED };
    for (const [cmd, pl] of Object.entries(COMMAND_PIPELINES)) {
      let from = pre[cmd];
      for (const to of pl.chain) {
        if (from === to) continue; // 幂等
        const info = transitionInfo(from, to);
        expect(info, `${cmd}: ${from} → ${to}`).not.toBeNull();
        from = to;
      }
      expect(pl.landing).toBeUndefined();
    }
  });

  it('通配收敛：仅 *→ASSEMBLED 与 *→FAILED；heal/rollback 无通配（M-24）', () => {
    const wilds = TRANSITIONS.filter((t) => t.from === '*').map((t) => t.to);
    expect(wilds).toEqual([STATES.ASSEMBLED, STATES.FAILED]);
    expect(TRANSITIONS.length).toBeGreaterThanOrEqual(20);
  });
});
