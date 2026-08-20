'use strict';
// test/launch.test.js — spawn 双形态（N 回归）+ 退出码传播 + 超时 + unref
const { launchProcess } = require('../infra/launch');
const { createFakeChild, coreWithSpawn } = require('./helpers');

describe('infra/launch spawn 双形态（审计 N/C/N29 回归）', () => {
  it('ENOENT 异步 error 事件 → ERR_LAUNCH_SPAWN（杜绝 LAUNCH OK 假成功）', async () => {
    const child = createFakeChild();
    const core = coreWithSpawn(() => child);
    const p = launchProcess(core, { harness: 'missing-bin', profile: '.', wait: true });
    child.emit('error', Object.assign(new Error('spawn missing-bin ENOENT'), { code: 'ENOENT' }));
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_LAUNCH_SPAWN');
  });

  it('UNKNOWN 同步 throw → ERR_LAUNCH_SPAWN（不崩溃进程）', async () => {
    const core = coreWithSpawn(() => { throw new Error('spawn UNKNOWN'); });
    const r = await launchProcess(core, { harness: 'broken', profile: '.', wait: true });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_LAUNCH_SPAWN');
  });

  it('wait 模式传播非零退出码 → ERR_LAUNCH_EXIT（契约退出码=8，QA Bug #1）', async () => {
    const child = createFakeChild();
    const core = coreWithSpawn(() => child);
    const p = launchProcess(core, { harness: 'x', profile: '.', wait: true });
    child.emit('exit', 3, null);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_LAUNCH_EXIT');
    expect(r.error.childExitCode).toBe(3); // 子进程真实退出码保留在独立字段
    expect(r.error.exitCode).toBe(8); // 契约退出码不被覆盖（P1 修复）
  });

  it('wait 模式退出码 0 → 成功', async () => {
    const child = createFakeChild();
    const core = coreWithSpawn(() => child);
    const p = launchProcess(core, { harness: 'x', profile: '.', wait: true });
    child.emit('exit', 0, null);
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.result.exitCode).toBe(0);
    expect(r.result.mode).toBe('wait');
  });

  it('wait 超时 → ERR_LAUNCH_TIMEOUT', async () => {
    const child = createFakeChild();
    const core = coreWithSpawn(() => child);
    const r = await launchProcess(core, { harness: 'x', profile: '.', wait: true, timeoutMs: 50 });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_LAUNCH_TIMEOUT');
  });

  it('detach 模式存活确认后 unref 返回（不挂起，N29 回归）', async () => {
    const child = createFakeChild();
    const core = coreWithSpawn(() => child);
    const r = await launchProcess(core, { harness: 'x', profile: '.', wait: false });
    expect(r.ok).toBe(true);
    expect(r.result.mode).toBe('detach');
    expect(r.result.alive).toBe(true);
    expect(child.unrefCalled).toBe(true);
  });

  it('detach 存活确认窗口内退出 → ERR_LAUNCH_DETACH', async () => {
    const child = createFakeChild();
    const core = coreWithSpawn(() => child);
    const p = launchProcess(core, { harness: 'x', profile: '.', wait: false });
    child.emit('exit', 1, null);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_LAUNCH_DETACH');
  });
});
