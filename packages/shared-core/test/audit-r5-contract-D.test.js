'use strict';
// test/audit-r5-contract-D.test.js — 契约/路径/锁/安全 第 5 轮独立审计（新发现缺陷，当前 FAIL）
//
// 本文件只做「钉死契约」的回归测试，不改源码、不改既有测试。
// 三个已实证缺陷：
//   D1  security/shell.js：assertShellSafeUrl / CMD_SPECIAL_RE 未覆盖 C1 控制字符区
//       （U+0080–U+009F，如 NEL U+0085），违背「无空白/控制字符」契约；
//       ids.js / path-safe.js 的 CONTROL_CHAR_RE 已补 C1（C2 修复），本模块漏补。
//   D2  contracts/errors.js：makeError 的 extra 保留字段剔除不完整，遗漏 name/stack，
//       调用方可经 extra 覆盖 Error 身份与调用栈（message 已剔除，name/stack 未剔除）。
//   D3  fs/lock.js：acquireLock 的「过期接管再次确认」continue 分支缺失 deadline 检查，
//       陈旧 token 持续抖动时无限自旋，waitMs 超时契约失效（经子进程实证：永不返回）。
const path = require('path');
const { spawnSync } = require('child_process');
const { CMD_SPECIAL_RE, assertShellSafeUrl } = require('../security/shell');
const { makeError } = require('../contracts/errors');
const { acquireLock } = require('../fs/lock');

describe('D1：assertShellSafeUrl / CMD_SPECIAL_RE 拒绝 C1 控制字符（U+0080–U+009F）', () => {
  it('CMD_SPECIAL_RE 覆盖 C1 控制字符区（与 ids/path-safe 的 CONTROL_CHAR_RE 一致）', () => {
    for (const ch of ['\u0080', '\u0085', '\u009f']) {
      expect(CMD_SPECIAL_RE.test(ch), `U+${ch.codePointAt(0).toString(16)}`).toBe(true);
    }
  });

  it('assertShellSafeUrl 拒绝含 C1 控制字符的 URL（无控制字符契约）', () => {
    for (const ch of ['\u0080', '\u0085', '\u009f']) {
      const r = assertShellSafeUrl(`https://x${ch}y`);
      expect(r.ok, `U+${ch.codePointAt(0).toString(16)}`).toBe(false);
    }
  });

  it('对照：C0 控制字符与空白仍被拒绝（既有行为不回归）', () => {
    expect(assertShellSafeUrl('https://x\u0000y').ok).toBe(false);
    expect(assertShellSafeUrl('https://x\ny').ok).toBe(false);
    expect(assertShellSafeUrl('https://x\u2028y').ok).toBe(false);
  });
});

describe('D2：makeError 的 extra 不得覆盖 Error 身份与调用栈', () => {
  it('extra 中的 name/stack 被剔除（与 exitCode/code/message 同为保留字段）', () => {
    const err = makeError('ERR_LOCK_ACQUIRE', 'm', {
      name: 'HackedError',
      stack: 'fake-stack',
      exitCode: 1,
      code: 'ERR_HACK',
      message: 'x'
    });
    expect(err.name).toBe('Error');
    expect(err.stack).not.toBe('fake-stack');
    expect(err.stack).toBeTruthy();
  });

  it('对照：合法 extra（cause/childExitCode）仍透传', () => {
    const cause = new Error('c');
    const err = makeError('ERR_LAUNCH_EXIT', 'm', { childExitCode: 3, cause });
    expect(err.childExitCode).toBe(3);
    expect(err.cause).toBe(cause);
    expect(err.exitCode).toBe(8);
  });
});

describe('D3：acquireLock 尊重 waitMs（陈旧 token 抖动不无限自旋）', () => {
  it('过期接管再次确认分支在 token 持续抖动时仍按 waitMs 超时返回', () => {
    const lockPath = path.join(__dirname, '..', 'fs', 'lock.js');
    const child = `
      'use strict';
      const { spawnSync } = require('child_process');
      const { acquireLock } = require(${JSON.stringify(lockPath)});
      // 两个真实已死 pid（probePid 判 ESRCH → 立即判陈旧）
      const d1 = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
      const d2 = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
      let reads = 0;
      const fsPort = {
        mkdirSync: () => {},
        openSync: () => { const e = new Error('EEXIST'); e.code = 'EEXIST'; e.syscall = 'open'; throw e; },
        writeFileSync: () => {},
        closeSync: () => {},
        fsyncSync: () => {},
        // 每次读返回「已死 pid + 旧时间戳」的陈旧 token，且相邻两次 pid 不同（持续抖动）
        readFileSync: () => { const pid = (reads % 2 === 0) ? d1 : d2; reads += 1; return pid + '\\n' + (Date.now() - 60000) + '\\n'; },
        statSync: () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; },
        existsSync: () => false,
        unlinkSync: () => {}
      };
      acquireLock(fsPort, 'X:\\\\fake\\\\lock', { waitMs: 150, staleMs: 30000, pollMs: 20, refreshMs: 0 });
      process.stdout.write('RETURNED');
    `;
    // 正确实现应在 ~150ms 内超时返回并打印 RETURNED；缺陷实现无限自旋 → 被 timeout 杀死、无输出。
    // 复审加固：timeout 从 1500 提至 8000——全量并行（23 文件大量真实子进程测试）下，子进程
    // 启动 + 嵌套 spawnSync 偶发触及 1500ms 上限导致空 stdout（测试自身时序敏感，非产品缺陷）。
    const r = spawnSync(process.execPath, ['-e', child], { encoding: 'utf8', timeout: 8000 });
    expect(r.stdout).toContain('RETURNED');
  });
});
