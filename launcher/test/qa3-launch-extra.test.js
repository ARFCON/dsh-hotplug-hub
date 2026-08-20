'use strict';
// test/qa3-launch-extra.test.js — launch spawn 真实子进程强化（QA3 第 2 层主题 7）
// 用真实 child_process 验证：ENOENT / 损坏 exe / 正常退出 0 / 崩溃退出 3 / 超时 / detach / 孤儿清理。
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launchProcess } = require('../infra/launch');
const { createCore } = require('../app/create-core');
const { createProcPort } = require('../ports/proc');
const { tempDir } = require('./helpers');

function realCore() {
  return createCore({
    baseDir: path.join(__dirname, '..'),
    home: os.tmpdir(),
    procPort: createProcPort({ spawn, spawnSync: () => ({ status: 1, error: null, stderr: '', stdout: '' }) })
  });
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('QA3 launch spawn 真实子进程（审计 N/C/N29 强化）', () => {
  it('ENOENT：不存在的可执行文件 → ERR_LAUNCH_SPAWN（exit=8 域）', async () => {
    const core = realCore();
    const r = await launchProcess(core, { harness: path.join(os.tmpdir(), 'qa3-no-such-bin-' + Date.now()), profile: '.', wait: true });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_LAUNCH_SPAWN');
    expect(r.error.exitCode).toBe(8);
  });

  it('损坏 exe（非 PE 文件）→ ERR_LAUNCH_SPAWN 不崩溃', async () => {
    const dir = tempDir('qa3-broken-exe-');
    const broken = path.join(dir, 'broken.exe');
    fs.writeFileSync(broken, 'this is not a PE executable file');
    const core = realCore();
    const r = await launchProcess(core, { harness: broken, profile: dir, wait: true });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_LAUNCH_SPAWN');
  });

  it('正常退出 0（--wait）→ LAUNCH OK exitCode=0', async () => {
    const core = realCore();
    const r = await launchProcess(core, { harness: process.execPath, profile: '.', args: ['-e', 'process.exit(0)'], wait: true });
    expect(r.ok).toBe(true);
    expect(r.result.exitCode).toBe(0);
    expect(r.result.mode).toBe('wait');
  });

  it('崩溃退出 3（--wait）→ ERR_LAUNCH_EXIT，childExitCode=3 且契约 exitCode=8', async () => {
    const core = realCore();
    const r = await launchProcess(core, { harness: process.execPath, profile: '.', args: ['-e', 'process.exit(3)'], wait: true });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_LAUNCH_EXIT');
    expect(r.error.childExitCode).toBe(3);
    expect(r.error.exitCode).toBe(8); // 契约退出码不被覆盖（QA Bug #1 修复实证）
  });

  it('超时：长驻子进程 + 短超时 → ERR_LAUNCH_TIMEOUT（孤儿风险见下一用例）', async () => {
    const core = realCore();
    const r = await launchProcess(core, {
      harness: process.execPath,
      profile: '.',
      args: ['-e', 'setInterval(()=>{}, 1000)'],
      wait: true,
      timeoutMs: 200
    });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_LAUNCH_TIMEOUT');
    // 注：launch.js 超时分支只 settle，未调用 child.kill() —— 孤儿进程由下一用例实证
  });

  it('detach 模式：长驻子进程存活确认后返回（不挂起），随后由测试主动清理', async () => {
    const core = realCore();
    const start = Date.now();
    const r = await launchProcess(core, {
      harness: process.execPath,
      profile: '.',
      args: ['-e', 'setInterval(()=>{}, 1000)'],
      wait: false
    });
    const elapsed = Date.now() - start;
    expect(r.ok).toBe(true);
    expect(r.result.mode).toBe('detach');
    expect(r.result.alive).toBe(true);
    expect(elapsed).toBeLessThan(3000); // 不挂起（N29）
    // 清理：detach 后进程已 unref，测试需手动 kill 防孤儿
    try { process.kill(r.result.pid, 'SIGKILL'); } catch (_) { /* 已退出 */ }
  });

  it('detach 模式：子进程存活确认后返回且最终自行退出（长轮询，容忍慢启动）', async () => {
    const core = realCore();
    const r = await launchProcess(core, {
      harness: process.execPath,
      profile: '.',
      args: ['-e', 'setTimeout(()=>process.exit(0), 800)'], // 800ms 后自行退出（> 500ms 存活窗口）
      wait: false
    });
    expect(r.ok).toBe(true);
    expect(r.result.mode).toBe('detach');
    // 沙箱内 node 子进程启动较慢：轮询至多 15s 等待其自行退出（无孤儿 = 无需外部 kill）
    let alive = true;
    for (let i = 0; i < 30; i += 1) {
      await waitMs(500);
      try { process.kill(r.result.pid, 0); } catch (_) { alive = false; break; }
    }
    expect(alive).toBe(false); // 已自行退出
  });

  it('SIGTERM 清理：wait 超时后子进程被清理（无孤儿，QA3 P2 修复回归）', async () => {
    // 独立复现：spawn 长驻 node 子进程 → launchProcess wait 超时 → 检查进程存活
    // 需求（手册 §3.4.6）：超时 → ERR_LAUNCH_TIMEOUT + SIGTERM 清理
    // 修复前（infra/launch.js 超时分支只 settle 无 kill）→ 子进程成孤儿（alive=true）
    // 修复后：超时 → SIGTERM（兜底 SIGKILL）→ 子进程退出（alive=false）
    let childPid = null;
    const procPort = createProcPort({
      spawn: (...args) => {
        const child = spawn(...args);
        childPid = child.pid;
        return child;
      },
      spawnSync: () => ({ status: 0 })
    });
    const core2 = createCore({ baseDir: path.join(__dirname, '..'), home: os.tmpdir(), procPort });
    const r = await launchProcess(core2, {
      harness: process.execPath,
      profile: '.',
      args: ['-e', 'console.log("STARTED"); setInterval(()=>{},1000)'],
      wait: true,
      timeoutMs: 300
    });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('ERR_LAUNCH_TIMEOUT');
    // 等待子进程退出（最多 15s；修复后超时即被 SIGTERM/SIGKILL 清理）。
    // 注：子进程可能在打印 STARTED 前即被清理，故轮询存活状态而非等待 STARTED。
    let alive = true;
    for (let i = 0; i < 30; i += 1) {
      try { process.kill(childPid, 0); } catch (_) { alive = false; break; }
      await waitMs(500);
    }
    expect(alive, '超时后子进程应被清理（无孤儿）').toBe(false);
    // 清理防测试残留
    try { process.kill(childPid, 'SIGKILL'); } catch (_) { /* 已退出 */ }
  });

  it('wait 模式 stdout/stderr 内容通过 onStdout/onStderr 回调捕获', async () => {
    const core = realCore();
    const out = [];
    const err = [];
    const r = await launchProcess(core, {
      harness: process.execPath,
      profile: '.',
      args: ['-e', 'console.log("hello-out"); console.error("hello-err")'],
      wait: true,
      onStdout: (d) => out.push(d.toString()),
      onStderr: (d) => err.push(d.toString())
    });
    expect(r.ok).toBe(true);
    expect(out.join('')).toContain('hello-out');
    expect(err.join('')).toContain('hello-err');
  });
});
