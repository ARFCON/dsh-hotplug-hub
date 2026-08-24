'use strict';
// infra/dsh-cli.js — 定位 dsh CLI（参照 scripts/install-plugins.mjs 的 findDshCli）
// 返回 {bin, args}，供 dsh plugin add 通道与 harness 回退使用。
const path = require('path');
const { makeError } = require('../contracts/errors');

// C6 修复：cmd.exe 包装的参数不得含 cmd 特殊字符（&|<>^%()!"）——Node spawn
// 会把参数内嵌引号转义为 \"（cmd 不识别），特殊字符则会被 cmd 按语法解析
// （命令注入/参数断裂）。此前 quoteCmdArg 手写引号同样被 libuv 转义破坏；
// 现在改为显式拒绝（调用方上游的 id/profile/spec 均已通过白名单校验，
// 正常值不含这些字符；异常值宁可报错也不静默注入）。
// 特殊字符集收敛于 infra/cmd-special.js（CMD_EXE_SPECIAL_RE，与契约
// CMD_SPECIAL_RE 的 POSIX shell 集不同——勿混用）。
const { CMD_EXE_SPECIAL_RE } = require('./cmd-special');

/**
 * 解析 cmd.exe 解释器绝对路径（R3：与 infra/launch.js、hotplug run-cli.js 同一加固）。
 * 优先级：注入 env 的 ComSpec → process.env.ComSpec（机器级常量，测试注入的 env
 * 快照可能丢失）→ SystemRoot\System32\cmd.exe 绝对路径（PATH 被隔离时仍可用）→
 * 裸 'cmd.exe'（极端缺 SystemRoot 的最后兜底，交由 CreateProcess 系统目录搜索）。
 * @param {object} core
 * @returns {string}
 */
function resolveCmdBin(core) {
  const env = core.config.env || {};
  if (env.ComSpec) return env.ComSpec;
  if (process.env.ComSpec) return process.env.ComSpec;
  const sysroot = env.SystemRoot || process.env.SystemRoot;
  return sysroot ? path.join(sysroot, 'System32', 'cmd.exe') : 'cmd.exe';
}

/**
 * 定位 dsh CLI。
 * 优先：1) DSH Desktop 内置 bin.js；2) ~/.dsh 内置 bin.js；3) PATH 上的 dsh。
 * @param {object} core
 * @param {object} [opts]
 * @param {string} [opts.profile] 目标 profile（用于拼 args）
 * @returns {{ok: boolean, bin?: string, args?: Array<string>, error?: Error}}
 */
function findDshCli(core, opts = {}) {
  const fsPort = core.ports.fs;
  const platform = core.config.platform;
  const env = core.config.env || process.env;
  const home = core.config.home || (typeof require('os').homedir === 'function' ? require('os').homedir() : '');
  const profile = opts.profile || 'web';

  // 1) DSH Desktop 内置 bin.js（最可靠，优先）
  const base = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const builtin = path.join(base, 'Programs', 'DSH Desktop', 'resources', 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (fsPort.existsSync(builtin)) {
    return { ok: true, bin: process.execPath, args: [builtin, 'plugin', '--profile', profile, 'add'] };
  }

  // 2) ~/.dsh 下的内置 dsh
  const alt = path.join(home, '.dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (fsPort.existsSync(alt)) {
    return { ok: true, bin: process.execPath, args: [alt, 'plugin', '--profile', profile, 'add'] };
  }

  // 3) PATH 上的 dsh（Windows 经 cmd.exe /c 包装；解释器走 ComSpec 绝对路径）
  if (platform === 'win32') {
    // C6 修复：profile 是已校验 id（白名单无特殊字符）；防御性拒绝异常值
    if (CMD_EXE_SPECIAL_RE.test(String(profile))) {
      return { ok: false, error: makeError('ERR_ARG_BAD_OPTION', `profile 含 cmd 特殊字符，拒绝经 cmd 执行：${profile}`) };
    }
    return { ok: true, bin: resolveCmdBin(core), args: ['/c', 'dsh', 'plugin', '--profile', profile, 'add'] };
  }
  return { ok: true, bin: 'dsh', args: ['plugin', '--profile', profile, 'add'] };
}

/**
 * 构造 dsh plugin add 完整命令（含包规格）。
 * @param {object} core
 * @param {object} opts
 * @param {string} opts.profile
 * @param {string} opts.packageSpec 如 name@1.2.3 或 tgz URL
 * @returns {{ok: boolean, bin?: string, args?: Array<string>, error?: Error}}
 */
function pluginAddCommand(core, opts) {
  const base = findDshCli(core, { profile: opts.profile });
  if (!base.ok) return base;
  const isWin = core.config.platform === 'win32';
  // C6 修复：win32 分支同样不做手写引号（libuv 转义破坏），改为显式拒绝特殊字符
  const spec = String(opts.packageSpec || '');
  if (isWin && CMD_EXE_SPECIAL_RE.test(spec)) {
    return { ok: false, error: makeError('ERR_ARG_BAD_OPTION', `包规格含 cmd 特殊字符，拒绝经 cmd 执行：${spec}`) };
  }
  return { ok: true, bin: base.bin, args: [...base.args, spec] };
}

module.exports = { findDshCli, pluginAddCommand, resolveCmdBin, CMD_EXE_SPECIAL_RE };
