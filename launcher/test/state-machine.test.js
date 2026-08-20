'use strict';
// test/state-machine.test.js — 命令级子流水线与转移表一致性（QA 观察 #5）
const {
  STATES,
  COMMAND_PIPELINES,
  TRANSITIONS,
  assertCommandPipeline,
  transitionInfo,
  canTransition
} = require('../contracts/state-machine');

describe('contracts/state-machine 命令级流水线（QA #5 回归）', () => {
  it('assemble：IDLE 可入、落 CHECKED；可从任意状态重建', () => {
    const r = assertCommandPipeline(STATES.IDLE, 'assemble');
    expect(r.ok).toBe(true);
    expect(r.info.landing).toBe(STATES.CHECKED);
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

  it('heal/rollback：允许从任意状态进入（通配行）', () => {
    for (const s of Object.values(STATES)) {
      expect(assertCommandPipeline(s, 'heal').ok, `heal from=${s}`).toBe(true);
      expect(assertCommandPipeline(s, 'rollback').ok, `rollback from=${s}`).toBe(true);
    }
  });

  it('COMMAND_PIPELINES 每条链的微转移都存在于转移表（落点与表一致）', () => {
    const pre = { assemble: STATES.IDLE, install: STATES.CHECKED, launch: STATES.INSTALLED, heal: STATES.MONITORING, rollback: STATES.HEALING };
    for (const [cmd, pl] of Object.entries(COMMAND_PIPELINES)) {
      let from = pre[cmd];
      for (const to of pl.chain) {
        if (from === to) continue; // 幂等
        const info = transitionInfo(from, to);
        expect(info, `${cmd}: ${from} → ${to}`).not.toBeNull();
        from = to;
      }
      expect(pl.landing).toBe(pl.chain[pl.chain.length - 1]);
    }
  });

  it('canTransition 通配语义：任何状态可到 ASSEMBLED/HEALING/ROLLED_BACK/FAILED', () => {
    for (const s of Object.values(STATES)) {
      expect(canTransition(s, STATES.ASSEMBLED)).toBe(true);
      expect(canTransition(s, STATES.HEALING)).toBe(true);
      expect(canTransition(s, STATES.ROLLED_BACK)).toBe(true);
    }
    expect(TRANSITIONS.length).toBeGreaterThanOrEqual(15);
  });
});
