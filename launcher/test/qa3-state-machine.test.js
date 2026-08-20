'use strict';
// test/qa3-state-machine.test.js — 状态机穷尽（QA3 第 2 层主题 11）
// 每条转移合法性（含非法转移必须被拒）/ COMMAND_PIPELINES 各链 / 通配转移 / 状态持久化后恢复。
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  STATES,
  TRANSITIONS,
  COMMAND_PIPELINES,
  canTransition,
  transitionInfo,
  assertTransition,
  assertCommandPipeline,
  isTerminal,
  nextStateFor
} = require('../contracts/state-machine');
const { createCore } = require('../app/create-core');
const { runPipeline } = require('../app/pipeline');

const ALL_STATES = Object.values(STATES);

describe('QA3 state-machine 穷尽（契约 20 转移强化）', () => {
  it('状态集合完整性：12 状态', () => {
    expect(ALL_STATES.sort()).toEqual([
      'ASSEMBLED', 'CHECKED', 'FAILED', 'HEALING', 'IDLE', 'INSTALLED',
      'LAUNCHED', 'MONITORING', 'QUARANTINED', 'RESOLVED', 'ROLLED_BACK', 'SYNCED'
    ]);
  });

  it('转移表每条 from→to 都可通过 assertTransition（合法转移全通过）', () => {
    for (const t of TRANSITIONS) {
      if (t.from === '*') continue; // 通配单独测
      const r = assertTransition(t.from, t.to, t.action);
      expect(r.ok, `合法转移 ${t.from}→${t.to} 应通过`).toBe(true);
    }
  });

  it('非法转移必须被拒：不在转移表（含通配）中的状态对 → ERR_ENV_UNSUPPORTED', () => {
    // 构造允许集合：精确转移 + 通配转移（* → to 对所有状态开放）
    const allowed = new Set();
    for (const t of TRANSITIONS) {
      if (t.from === '*') {
        for (const s of ALL_STATES) allowed.add(`${s}->${t.to}`);
      } else {
        allowed.add(`${t.from}->${t.to}`);
      }
    }
    let allowedCount = 0;
    let rejectedCount = 0;
    for (const from of ALL_STATES) {
      for (const to of ALL_STATES) {
        if (from === to) continue; // 幂等重入合法
        const key = `${from}->${to}`;
        const r = assertTransition(from, to);
        if (allowed.has(key)) {
          expect(r.ok, `应允许 ${key}`).toBe(true);
          allowedCount += 1;
        } else {
          expect(r.ok, `应拒绝非法 ${key}`).toBe(false);
          expect(r.error.code).toBe('ERR_ENV_UNSUPPORTED');
          rejectedCount += 1;
        }
      }
    }
    // 12*11=132 对；合法 = allowedCount；其余全部拒绝
    expect(allowedCount + rejectedCount).toBe(ALL_STATES.length * (ALL_STATES.length - 1));
    expect(rejectedCount).toBeGreaterThan(0);
  });

  it('通配转移：任意状态可达 ASSEMBLED/HEALING/ROLLED_BACK/FAILED', () => {
    for (const s of ALL_STATES) {
      expect(canTransition(s, STATES.ASSEMBLED)).toBe(true);
      expect(canTransition(s, STATES.HEALING)).toBe(true);
      expect(canTransition(s, STATES.ROLLED_BACK)).toBe(true);
      expect(canTransition(s, STATES.FAILED)).toBe(true);
    }
  });

  it('COMMAND_PIPELINES：每条链的相邻微转移都存在于转移表', () => {
    const pre = { assemble: STATES.IDLE, install: STATES.CHECKED, launch: STATES.INSTALLED, heal: STATES.MONITORING, rollback: STATES.HEALING };
    for (const [cmd, pl] of Object.entries(COMMAND_PIPELINES)) {
      let from = pre[cmd];
      for (const to of pl.chain) {
        if (from === to) continue;
        expect(transitionInfo(from, to), `${cmd}: ${from}→${to}`).not.toBeNull();
        from = to;
      }
      expect(pl.landing).toBe(pl.chain[pl.chain.length - 1]);
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

  it('isTerminal：FAILED/QUARANTINED/ROLLED_BACK 为终止态', () => {
    expect(isTerminal(STATES.FAILED)).toBe(true);
    expect(isTerminal(STATES.QUARANTINED)).toBe(true);
    expect(isTerminal(STATES.ROLLED_BACK)).toBe(true);
    expect(isTerminal(STATES.IDLE)).toBe(false);
    expect(isTerminal(STATES.MONITORING)).toBe(false);
  });

  it('nextStateFor：按 action 推导目标状态', () => {
    expect(nextStateFor('assemble', STATES.IDLE)).toBe(STATES.ASSEMBLED);
    expect(nextStateFor('heal', STATES.MONITORING)).toBe(STATES.HEALING);
    expect(nextStateFor('reassemble', STATES.HEALING)).toBe(STATES.ASSEMBLED); // 通配
    expect(nextStateFor('rollback-any', STATES.MONITORING)).toBe(STATES.ROLLED_BACK);
    expect(nextStateFor('no-such-action', STATES.IDLE)).toBeNull();
  });

  it('状态持久化后恢复：assemble 落 CHECKED → 新 pipeline 读到 CHECKED → launch 被拒', async () => {
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
    // 新 core（模拟新进程）读同一 state → launch 被拒（未 install）
    const core2 = createCore({ roots });
    const r2 = await runPipeline(core2, 'launch', args);
    expect(r2.ok).toBe(false);
    expect(r2.exitCode).toBe(12); // ERR_ENV_UNSUPPORTED
  });
});
