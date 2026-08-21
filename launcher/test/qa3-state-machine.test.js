'use strict';
// test/qa3-state-machine.test.js — 状态机穷尽（QA3 第 2 层主题 11 + v5 M-24/36/R-v5-20）
// 每条转移合法性（含非法转移必须被拒）/ COMMAND_PIPELINES 各链 / 通配收敛 /
// 状态持久化后恢复。
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  STATES,
  TRANSITIONS,
  COMMAND_PIPELINES,
  transitionInfo,
  assertCommandPipeline
} = require('../contracts/state-machine');
const { createCore } = require('../app/create-core');
const { runPipeline } = require('../app/pipeline');

const ALL_STATES = Object.values(STATES);

describe('QA3 state-machine 穷尽（契约 20 转移强化 + v5 定向修复）', () => {
  it('状态集合完整性：12 状态', () => {
    expect(ALL_STATES.sort()).toEqual([
      'ASSEMBLED', 'CHECKED', 'FAILED', 'HEALING', 'IDLE', 'INSTALLED',
      'LAUNCHED', 'MONITORING', 'QUARANTINED', 'RESOLVED', 'ROLLED_BACK', 'SYNCED'
    ]);
  });

  it('转移表每条精确 from→to 都可在表中查到（transitionInfo）', () => {
    for (const t of TRANSITIONS) {
      if (t.from === '*') continue; // 通配单独测
      const info = transitionInfo(t.from, t.to);
      expect(info, `合法转移 ${t.from}→${t.to} 应在表中`).not.toBeNull();
    }
  });

  it('M-24：转移表不含 *→HEALING / *→ROLLED_BACK 通配；非法转移专属码 ERR_ARG_BAD_STATE', () => {
    expect(TRANSITIONS.some((t) => t.from === '*' && t.to === STATES.HEALING)).toBe(false);
    expect(TRANSITIONS.some((t) => t.from === '*' && t.to === STATES.ROLLED_BACK)).toBe(false);
    // 通配只剩 *→ASSEMBLED 与 *→FAILED
    const wilds = TRANSITIONS.filter((t) => t.from === '*').map((t) => t.to);
    expect(wilds).toEqual([STATES.ASSEMBLED, STATES.FAILED]);
    // IDLE 直接 heal/rollback 必须被拒（M-24 核心实证）
    const h = assertCommandPipeline(STATES.IDLE, 'heal');
    expect(h.ok).toBe(false);
    expect(h.error.code).toBe('ERR_ARG_BAD_STATE');
    expect(h.error.exitCode).toBe(2);
    const r = assertCommandPipeline(STATES.IDLE, 'rollback');
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_ARG_BAD_STATE');
  });

  it('COMMAND_PIPELINES：每条链的相邻微转移都存在于转移表（R-v5-20：无 landing）', () => {
    const pre = { assemble: STATES.IDLE, install: STATES.CHECKED, launch: STATES.INSTALLED, heal: STATES.MONITORING, rollback: STATES.INSTALLED };
    for (const [cmd, pl] of Object.entries(COMMAND_PIPELINES)) {
      let from = pre[cmd];
      for (const to of pl.chain) {
        if (from === to) continue;
        expect(transitionInfo(from, to), `${cmd}: ${from}→${to}`).not.toBeNull();
        from = to;
      }
      expect(pl.landing).toBeUndefined();
    }
  });

  it('assertCommandPipeline：非法前置状态拒绝（launch 未 install、install 未 assemble）', () => {
    expect(assertCommandPipeline(STATES.IDLE, 'install').ok).toBe(false);
    expect(assertCommandPipeline(STATES.ASSEMBLED, 'install').ok).toBe(false);
    expect(assertCommandPipeline(STATES.RESOLVED, 'install').ok).toBe(false);
    expect(assertCommandPipeline(STATES.CHECKED, 'launch').ok).toBe(false);
    expect(assertCommandPipeline(STATES.IDLE, 'launch').ok).toBe(false);
    expect(assertCommandPipeline(STATES.INSTALLED, 'launch').ok).toBe(true);
  });

  it('R-v5-20：装饰函数已删除（canTransition/assertTransition/isTerminal/nextStateFor）', () => {
    const mod = require('../contracts/state-machine');
    expect(mod.canTransition).toBeUndefined();
    expect(mod.assertTransition).toBeUndefined();
    expect(mod.isTerminal).toBeUndefined();
    expect(mod.nextStateFor).toBeUndefined();
  });

  it('状态持久化后恢复：assemble 落 CHECKED → 新 pipeline 读到 CHECKED → launch 被拒（M-36 码）', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qa3-sm-'));
    const roots = {
      assemblyDir: path.join(base, 'assembly'),
      sandboxRoot: path.join(base, 'sandbox', '.sandbox'),
      profilesRoot: path.join(base, 'profiles'),
      storeRoot: path.join(base, 'store')
    };
    const id = 'sm-demo';
    const dir = path.join(roots.assemblyDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'assembly.json'), JSON.stringify({
      hotpack: '1.0', id, name: '状态机', version: '1.0.0',
      plugins: [{ id: 'a', name: 'pkg-a', version: '1.0.0', source: { type: 'npm' }, config: {} }]
    }));
    const core = createCore({ roots });
    const args = { id, yes: false, wait: false, timeoutMs: 1000, tail: 50 };
    const r1 = await runPipeline(core, 'assemble', args);
    expect(r1.ok).toBe(true);
    // 持久化后 phase=CHECKED
    const stateFile = path.join(roots.storeRoot, id, 'state.json');
    const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(persisted.phase).toBe('CHECKED');
    // 新 core（模拟新进程）读同一 state → launch 被拒（未 install）→ ERR_ARG_BAD_STATE（exit=2）
    const core2 = createCore({ roots });
    const r2 = await runPipeline(core2, 'launch', args);
    expect(r2.ok).toBe(false);
    expect(r2.code).toBe('ERR_ARG_BAD_STATE');
    expect(r2.exitCode).toBe(2);
  });
});
