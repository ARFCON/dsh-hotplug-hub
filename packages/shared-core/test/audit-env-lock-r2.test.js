'use strict';
// test/audit-env-lock-r2.test.js — 第二轮共享内核加固验收
//
// S1：sanitizeChildEnv 在 Windows 必须大小写不敏感地剥离封锁清单（env 名在 OS 层
//     大小写不敏感，{...env} 展开保留原始大小写、精确大小写 delete 会漏掉
//     node_options / git_ssh_command 等变体——封锁清单可被绕过）。
// S2：acquireLock 的过期接管在决策与 unlink 之间必须二次确认 token 未变——否则
//     另一等待者恰在此窗口完成接管+刷新时，会把【活锁】误删（双持有者）。
const { spawnSync } = require('child_process');
const { sanitizeChildEnv } = require('../security/net');
const { acquireLock } = require('../fs/lock');

/** 已退出的真实 pid（probePid 判死）。 */
function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  return r.pid;
}

describe('S1：sanitizeChildEnv Windows 大小写不敏感剥离', () => {
  it.skipIf(process.platform !== 'win32')('小写变体 node_options / node_tls_reject_unauthorized / git_ssh_command 被剥离', () => {
    const env = {
      PATH: 'C:\\Windows',
      node_options: '--require evil.js',
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
      node_extra_ca_certs: 'C:\\evil.pem',
      git_ssh_command: 'ssh -oProxyCommand=evil',
      LD_PRELOAD: '/tmp/evil.so',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    };
    const out = sanitizeChildEnv(env);
    expect(out).not.toHaveProperty('node_options');
    expect(out).not.toHaveProperty('NODE_TLS_REJECT_UNAUTHORIZED');
    expect(out).not.toHaveProperty('node_extra_ca_certs');
    expect(out).not.toHaveProperty('git_ssh_command');
    expect(out).not.toHaveProperty('LD_PRELOAD');
    expect(out).toHaveProperty('PATH');
    expect(out).toHaveProperty('ComSpec');
  });

  it.skipIf(process.platform !== 'win32')('keepNodeOptions=true 时大小写变体的 node_options 均保留', () => {
    const out = sanitizeChildEnv({
      node_options: '--keep',
      NODE_OPTIONS: '--keep2',
    }, { keepNodeOptions: true });
    expect(out).toHaveProperty('node_options');
    expect(out).toHaveProperty('NODE_OPTIONS');
  });

  it.skipIf(process.platform === 'win32')('POSIX：env 大小写敏感，node_options 是不同变量（保留）', () => {
    const out = sanitizeChildEnv({ NODE_OPTIONS: '--x', node_options: '--y' });
    expect(out).not.toHaveProperty('NODE_OPTIONS');
    expect(out).toHaveProperty('node_options');
  });

  it('既有行为回归：精确大小写封锁项剥离 + 空对象安全', () => {
    const out = sanitizeChildEnv({
      NODE_OPTIONS: '--x', SSL_CERT_FILE: '/x', GIT_SSH: 'x', HARMLESS: '1',
    });
    expect(out).not.toHaveProperty('NODE_OPTIONS');
    expect(out).not.toHaveProperty('SSL_CERT_FILE');
    expect(out).not.toHaveProperty('GIT_SSH');
    expect(out).toHaveProperty('HARMLESS');
    expect(sanitizeChildEnv({})).toEqual({});
  });
});

describe('S2：过期接管二次确认（不误删活锁）', () => {
  function fakePortFactory() {
    const calls = { reads: 0, unlinks: 0, opens: 0 };
    const staleToken = `${deadPid()}\n${Date.now() - 60000}\n`; // 判定过期的 token
    const liveToken = `${process.pid}\n${Date.now()}\n`;        // 新持有者的活 token
    const lockPath = 'X:\\fake\lock'; // 不落盘，全部走桩
    const port = {
      mkdirSync: () => {},
      openSync: (p, flag) => {
        if (String(p) === lockPath && String(flag) === 'wx') {
          calls.opens += 1;
          const err = new Error('EEXIST');
          err.code = 'EEXIST';
          throw err;
        }
        return 0;
      },
      writeFileSync: () => {},
      closeSync: () => {},
      readFileSync: (p) => {
        if (String(p) === lockPath) {
          calls.reads += 1;
          return calls.reads === 1 ? staleToken : liveToken; // 首读=过期；此后=新持有者
        }
        throw new Error('ENOENT');
      },
      statSync: () => { throw new Error('ENOENT'); },
      existsSync: (p) => String(p) === lockPath,
      unlinkSync: (p) => { if (String(p) === lockPath) calls.unlinks += 1; },
    };
    return { port, calls, lockPath };
  }

  it('首读过期、接管前 token 已被新持有者刷新 → 不 unlink 活锁，等待至超时', () => {
    const { port, calls, lockPath } = fakePortFactory();
    const r = acquireLock(port, lockPath, { waitMs: 250, pollMs: 50, staleMs: 30000, refreshMs: 0 });
    expect(r.ok).toBe(false); // 活锁在持 → 等待超时
    expect(calls.unlinks).toBe(0); // 绝不误删
  });

  it('token 确实仍是过期 token（无人接管）→ 正常 unlink 接管', () => {
    const calls = { reads: 0, unlinks: 0, opens: 0 };
    const stale = `${deadPid()}\n${Date.now() - 60000}\n`;
    const lockPath = 'X:\\fake\\lock2';
    const port = {
      mkdirSync: () => {},
      openSync: (p, flag) => {
        if (String(p) === lockPath && String(flag) === 'wx') {
          calls.opens += 1;
          if (calls.opens > 1) return 7; // 首次 EEXIST（旧锁在）；接管 unlink 后重建成功
          const err = new Error('EEXIST'); err.code = 'EEXIST'; throw err;
        }
        return 0;
      },
      writeFileSync: () => {},
      closeSync: () => {},
      readFileSync: () => stale,
      statSync: () => { throw new Error('ENOENT'); },
      existsSync: (p) => String(p) === lockPath && calls.opens <= 1,
      unlinkSync: (p) => { if (String(p) === lockPath) calls.unlinks += 1; },
    };
    const r = acquireLock(port, lockPath, { waitMs: 500, pollMs: 50, staleMs: 30000, refreshMs: 0 });
    expect(r.ok).toBe(true);
    expect(calls.unlinks).toBe(1); // 真过期 → 接管照常
    if (r.release) r.release();
  });
});
