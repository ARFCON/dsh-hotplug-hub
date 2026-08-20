'use strict';
// infra/harness.js — 官方 DSH 探测 + 完整性校验
//
// 审计修复：
//   - N44：可执行文件劫持 —— 候选必须位于可信根、非符号链接、体积 > 0
//   - N5：Windows 补齐 dsh CLI 回退
//   - H：harness 校验必须先于 profile 同步副作用
const os = require('os');
const path = require('path');
const { makeError } = require('../contracts/errors');

/**
 * 按平台生成候选路径。
 * @param {string} platform
 * @param {object} env 环境变量（LOCALAPPDATA/ProgramFiles/ProgramFiles(x86)）
 * @param {string} home os.homedir()
 * @returns {Array<string>}
 */
function candidatePaths(platform, env, home) {
  const list = [];
  if (platform === 'darwin') {
    list.push(
      '/Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop',
      '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
      path.join(home, 'Applications', 'DSH Desktop.app', 'Contents', 'MacOS', 'DSH Desktop'),
      path.join(home, 'Applications', 'DeepSeek Harness.app', 'Contents', 'MacOS', 'DeepSeek Harness')
    );
  } else if (platform === 'linux') {
    list.push(
      '/usr/local/bin/dsh',
      '/usr/bin/dsh',
      path.join(home, '.local', 'bin', 'dsh'),
      path.join(home, 'Applications', 'DSH Desktop', 'dsh')
    );
  } else {
    // win32
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const pf = env.ProgramFiles || 'C:\\Program Files';
    const pfx = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    list.push(
      path.join(local, 'Programs', 'DSH Desktop', 'DSH Desktop.exe'),
      path.join(pf, 'DSH Desktop', 'DSH Desktop.exe'),
      path.join(pfx, 'DSH Desktop', 'DSH Desktop.exe'),
      path.join(home, 'AppData', 'Local', 'Programs', 'DSH Desktop', 'DSH Desktop.exe')
    );
  }
  return list;
}

/**
 * 完整性校验（N44）：存在 + 普通文件 + 体积 > 0 + 非符号链接。
 * @param {object} fsPort
 * @param {string} file
 * @returns {{ok: boolean, error?: Error}}
 */
function verifyHarness(fsPort, file) {
  try {
    if (!fsPort.existsSync(file)) {
      return { ok: false, error: makeError('ERR_HARNESS_NOT_FOUND', `harness 不存在：${file}`) };
    }
    const st = fsPort.statSync(file);
    if (!st.isFile()) {
      return { ok: false, error: makeError('ERR_HARNESS_UNTRUSTED', `harness 不是普通文件：${file}`) };
    }
    if (st.size <= 0) {
      return { ok: false, error: makeError('ERR_HARNESS_UNTRUSTED', `harness 体积异常（${st.size} 字节）：${file}`) };
    }
    // 拒绝符号链接（防劫持：攻击者放置软链指向任意可执行文件）
    try {
      const lst = fsPort.lstatSync(file);
      if (lst.isSymbolicLink()) {
        return { ok: false, error: makeError('ERR_HARNESS_UNTRUSTED', `harness 是符号链接，拒绝执行：${file}`) };
      }
    } catch (_) { /* lstat 不可用则跳过 */ }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: makeError('ERR_HARNESS_UNTRUSTED', `harness 校验失败：${e.message}`) };
  }
}

/**
 * 探测官方 harness（先候选，后 dsh CLI 回退）。
 * @param {object} core
 * @param {object} [opts]
 * @param {string} [opts.platform]
 * @param {boolean} [opts.probe] 是否允许 spawn 探测 PATH 上的 dsh CLI（默认 true；
 *   只读命令如 status 应传 false，保持零子进程副作用——FIX-22/只读契约强化）
 * @returns {{ok: boolean, harness?: string, error?: Error}}
 */
function findHarness(core, opts = {}) {
  const platform = opts.platform || core.config.platform;
  const env = core.config.env || process.env;
  const home = core.config.home || os.homedir();
  const fsPort = core.ports.fs;

  const candidates = candidatePaths(platform, env, home);
  let lastError = null;
  for (const c of candidates) {
    if (!fsPort.existsSync(c)) continue;
    const v = verifyHarness(fsPort, c);
    if (v.ok) return { ok: true, harness: c };
    // FIX-11：候选校验失败继续尝试下一个（候选1损坏不影响候选2）
    lastError = v.error;
  }

  // dsh CLI 回退（N5/FIX-11）：真实探测 PATH（where/which，Windows 兼容 dsh.cmd），
  // 不再用 existsSync('dsh') 相对路径误判。
  // 回退结果同样必须过 verifyHarness（A2 修复：N44 完整性校验缺口——此前
  // PATH 上的符号链接/零字节文件会被直接采纳为 harness 并执行）。
  if (opts.probe !== false && procPortAvailable(core)) {
    const probe = platform === 'win32'
      ? core.ports.proc.spawnSync('where', ['dsh.cmd'], { stdio: 'pipe', encoding: 'utf8' })
      : core.ports.proc.spawnSync('sh', ['-c', 'command -v dsh'], { stdio: 'pipe', encoding: 'utf8' });
    if (probe && !probe.error && probe.status === 0 && (probe.stdout || '').trim()) {
      const cliPath = (probe.stdout || '').trim().split(/\r?\n/)[0];
      if (cliPath) {
        const v = verifyHarness(fsPort, cliPath);
        if (v.ok) return { ok: true, harness: cliPath };
        lastError = v.error;
      }
    }
  }

  if (lastError && lastError.code !== 'ERR_HARNESS_NOT_FOUND') {
    return { ok: false, error: lastError };
  }
  return { ok: false, error: makeError('ERR_HARNESS_NOT_FOUND', '未找到官方 DSH 桌面端或 dsh CLI') };
}

function procPortAvailable(core) {
  return core.ports && core.ports.proc && typeof core.ports.proc.spawnSync === 'function';
}

module.exports = { candidatePaths, verifyHarness, findHarness };
