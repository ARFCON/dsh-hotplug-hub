'use strict';
// test/state-machine.test.js — 状态表与命令流水线（M-24/25/35/36 + R-v5-20 后语义）
const {
  STATES, TRANSITIONS, COMMAND_PIPELINES, transitionInfo, assertCommandPipeline
} = require('../contracts/state-machine');

describe('状态表', () => {
  it('STATES 完整', () => {
    expect(STATES.IDLE).toBe('IDLE');
    expect(STATES.FAILED).toBe('FAILED');
    expect(Object.keys(STATES)).toHaveLength(12);
  });
  it('M-24：heal/rollback 不再通配', () => {
    // 通配已被删除：不存在 *→HEALING / *→ROLLED_BACK
    const healWild = TRANSITIONS.find((t) => t.from === '*' && t.to === STATES.HEALING);
    const rbWild = TRANSITIONS.find((t) => t.from === '*' && t.to === STATES.ROLLED_BACK);
    expect(healWild).toBeUndefined();
    expect(rbWild).toBeUndefined();
    // 显式入口保留（已进入安装/同步/启动域的状态）
    for (const s of [STATES.INSTALLED, STATES.SYNCED, STATES.LAUNCHED, STATES.MONITORING, STATES.QUARANTINED, STATES.ROLLED_BACK, STATES.FAILED]) {
      expect(transitionInfo(s, STATES.HEALING), `heal from ${s}`).not.toBeNull();
    }
    for (const s of [STATES.INSTALLED, STATES.SYNCED, STATES.LAUNCHED, STATES.MONITORING, STATES.QUARANTINED, STATES.FAILED]) {
      expect(transitionInfo(s, STATES.ROLLED_BACK), `rollback from ${s}`).not.toBeNull();
    }
    // 组装期（IDLE/ASSEMBLED/RESOLVED/CHECKED）无入口
    for (const s of [STATES.IDLE, STATES.ASSEMBLED, STATES.RESOLVED, STATES.CHECKED]) {
      expect(transitionInfo(s, STATES.HEALING), `heal from ${s}`).toBeNull();
      expect(transitionInfo(s, STATES.ROLLED_BACK), `rollback from ${s}`).toBeNull();
    }
  });
  it('R-v5-20：装饰函数已删除', () => {
    // canTransition/assertTransition/isTerminal/nextStateFor 不再导出
    const mod = require('../contracts/state-machine');
    expect(mod.canTransition).toBeUndefined();
    expect(mod.assertTransition).toBeUndefined();
    expect(mod.isTerminal).toBeUndefined();
    expect(mod.nextStateFor).toBeUndefined();
    // COMMAND_PIPELINES 无 landing 字段
    expect(COMMAND_PIPELINES.assemble.landing).toBeUndefined();
    expect(COMMAND_PIPELINES.launch.landing).toBeUndefined();
  });
  it('通配保留：*→ASSEMBLED（幂等重建）与 *→FAILED（错误兜底）', () => {
    expect(transitionInfo('ANY_STATE', STATES.ASSEMBLED)).not.toBeNull();
    expect(transitionInfo('ANY_STATE', STATES.FAILED)).not.toBeNull();
  });
});

describe('assertCommandPipeline', () => {
  it('命令链合法：assemble / install / launch / heal / rollback', () => {
    expect(assertCommandPipeline(STATES.IDLE, 'assemble').ok).toBe(true);
    expect(assertCommandPipeline(STATES.CHECKED, 'install').ok).toBe(true);
    expect(assertCommandPipeline(STATES.INSTALLED, 'launch').ok).toBe(true);
    expect(assertCommandPipeline(STATES.MONITORING, 'heal').ok).toBe(true);
    expect(assertCommandPipeline(STATES.INSTALLED, 'heal').ok).toBe(true); // 崩溃后自愈
    expect(assertCommandPipeline(STATES.LAUNCHED, 'heal').ok).toBe(true);
    expect(assertCommandPipeline(STATES.INSTALLED, 'rollback').ok).toBe(true);
    expect(assertCommandPipeline(STATES.LAUNCHED, 'rollback').ok).toBe(true);
  });
  it('M-24：IDLE/组装期不得直接 heal/rollback（专属错误码 ERR_ARG_BAD_STATE，exit=2）', () => {
    for (const phase of [STATES.IDLE, STATES.ASSEMBLED, STATES.RESOLVED, STATES.CHECKED]) {
      const h = assertCommandPipeline(phase, 'heal');
      expect(h.ok, `heal from ${phase}`).toBe(false);
      expect(h.error.code).toBe('ERR_ARG_BAD_STATE');
      expect(h.error.exitCode).toBe(2);
      const r = assertCommandPipeline(phase, 'rollback');
      expect(r.ok, `rollback from ${phase}`).toBe(false);
      expect(r.error.code).toBe('ERR_ARG_BAD_STATE');
    }
  });
  it('非法前置状态拒绝（launch 未 install 等）', () => {
    expect(assertCommandPipeline(STATES.IDLE, 'install').ok).toBe(false);
    expect(assertCommandPipeline(STATES.ASSEMBLED, 'install').ok).toBe(false);
    expect(assertCommandPipeline(STATES.CHECKED, 'launch').ok).toBe(false);
    expect(assertCommandPipeline(STATES.IDLE, 'launch').ok).toBe(false);
  });
  it('幂等重入', () => {
    expect(assertCommandPipeline(STATES.CHECKED, 'assemble').ok).toBe(true);
    expect(assertCommandPipeline(STATES.LAUNCHED, 'launch').ok).toBe(true);
    expect(assertCommandPipeline(STATES.ROLLED_BACK, 'rollback').ok).toBe(true);
  });
  it('未知命令显式报错（T1）', () => {
    const r = assertCommandPipeline(STATES.IDLE, 'frobnicate');
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_ARG_UNKNOWN_COMMAND');
  });
  it('R-v5-20：info 无 landing 字段', () => {
    const r = assertCommandPipeline(STATES.IDLE, 'assemble');
    expect(r.ok).toBe(true);
    expect(r.info.landing).toBeUndefined();
    expect(r.info.chain).toEqual([STATES.ASSEMBLED, STATES.RESOLVED, STATES.CHECKED]);
  });
});
