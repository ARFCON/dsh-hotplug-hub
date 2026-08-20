'use strict';
// infra/install.js — 插件安装（dsh plugin add 通道 + 降级 npm install）
//
// 审计修复：B（插件源从不落地）— npm 源进 dependencies 并安装；
// github/path 源校验目标存在并建 link。副作用全部经端口注入。
const path = require('path');
const { GITHUB_MIRRORS } = require('../contracts/constants');
const { makeError } = require('../contracts/errors');

/**
 * 安装 npm 插件：优先 dsh plugin add 通道，降级 npm install。
 * @param {object} core
 * @param {object} plugin resolved 插件
 * @param {string} profile profile 目录
 * @returns {Promise<{ok: boolean, channel?: string, error?: Error}>}
 */
async function installNpmPlugin(core, plugin, profile) {
  const dshPort = core.ports.dsh;
  const procPort = core.ports.proc;
  const fsPort = core.ports.fs;
  const version = plugin.resolvedVersion || plugin.version;

  // 1) dsh plugin add 通道（参照 scripts/install-plugins.mjs）
  try {
    const r = await dshPort.pluginAdd(profile, plugin.name, version);
    if (r && r.ok) return { ok: true, channel: 'dsh' };
  } catch (e) {
    // 通道不可用 → 降级
  }

  // 2) 降级：npm install <name>@<version>
  // C6 修复：win32 下 npm 是 npm.cmd，spawnSync('npm') 直接执行返回 ENOENT——
  // 降级通道在 Windows 恒失败；与 findDshCli 相同处理：cmd.exe /c 包装。
  const spec = version ? `${plugin.name}@${version}` : plugin.name;
  const isWin = core.config.platform === 'win32';
  const npmBin = isWin ? 'cmd.exe' : 'npm';
  const npmArgs = isWin
    ? ['/c', 'npm', 'install', '--no-audit', '--no-fund', spec]
    : ['install', '--no-audit', '--no-fund', spec];
  let sr;
  try {
    sr = procPort.spawnSync(npmBin, npmArgs, {
      cwd: profile,
      stdio: 'pipe',
      encoding: 'utf8'
    });
  } catch (e) {
    return { ok: false, error: makeError('ERR_INSTALL_FAILED', `npm install 无法执行：${e.message}`) };
  }
  if (sr.error || sr.status !== 0) {
    const msg = (sr.error && sr.error.message) || (sr.stderr || '').slice(0, 500);
    // C6 修复：透传真实子进程退出码（childExitCode），stageInstall 持久化到
    // state.install.lastExit——与 launch 的 childExitCode 语义一致。
    return { ok: false, error: makeError('ERR_INSTALL_FAILED', `npm install 失败：${msg}`, { childExitCode: sr.status === null ? 1 : sr.status }) };
  }
  // 校验落地
  const nm = path.join(profile, 'node_modules', plugin.name);
  if (!fsPort.existsSync(nm)) {
    return { ok: false, error: makeError('ERR_INSTALL_DEP', `安装后 node_modules/${plugin.name} 不存在`) };
  }
  return { ok: true, channel: 'npm' };
}

/**
 * 安装 path 源插件：校验目标存在 + 建立真实链接（junction/dir-symlink）。
 * C6 修复：此前只复制 package.json（"复制壳"）——DSH require 不到插件代码，
 * 属"插件不落地"（审计 B）的残留形态。现在优先建链接；链接不可用时
 * 回退复制壳并返回 note（显式可观测，不静默）。
 * @param {object} core
 * @param {object} plugin
 * @param {string} profile
 * @returns {{ok: boolean, note?: string, error?: Error}}
 */
function installPathPlugin(core, plugin, profile) {
  const fsPort = core.ports.fs;
  const target = plugin.installPath;
  if (!target || !fsPort.existsSync(target)) {
    return { ok: false, error: makeError('ERR_INSTALL_DEP', `path 源目标不存在：${target}`) };
  }
  const linkDir = path.join(profile, 'node_modules', plugin.name);
  try {
    fsPort.mkdirSync(path.dirname(linkDir), { recursive: true });
    // 已有占位（旧复制壳/陈旧链接）先清理
    if (fsPort.existsSync(linkDir)) {
      try {
        const lst = fsPort.lstatSync(linkDir);
        if (lst.isSymbolicLink()) {
          try { fsPort.rmdirSync(linkDir); } catch (_) { fsPort.unlinkSync(linkDir); }
        } else {
          fsPort.rmSync(linkDir, { recursive: true, force: true });
        }
      } catch (_) { /* 清理失败继续尝试建链 */ }
    }
    // 优先真实链接：junction（Windows 免管理员）/ dir symlink（POSIX）
    if (typeof fsPort.symlinkSync === 'function') {
      try {
        fsPort.symlinkSync(target, linkDir, 'junction');
        return { ok: true };
      } catch (linkErr) {
        // 链接失败（EINVAL/EPERM/不支持）→ 回退复制壳，note 显式记录
        const fallback = copyShell(fsPort, target, linkDir);
        return fallback.ok
          ? { ok: true, note: `链接失败已回退复制壳（${linkErr.message}）` }
          : fallback;
      }
    }
    const fallback = copyShell(fsPort, target, linkDir);
    return fallback.ok
      ? { ok: true, note: '环境不支持链接，已使用复制壳' }
      : fallback;
  } catch (e) {
    // C6 修复：mkdir/copy 失败（EACCES/ENOSPC/名称被占）映射语义错误码，不裸抛 FATAL
    return { ok: false, error: makeError('ERR_INSTALL_FAILED', `path 源安装失败 ${plugin.name}：${e.message}`) };
  }
}

/** 复制壳回退：建立可识别目录并复制 package.json（真实链接不可用时的降级）。 */
function copyShell(fsPort, target, linkDir) {
  try {
    fsPort.mkdirSync(linkDir, { recursive: true });
    const srcPkg = path.join(target, 'package.json');
    if (fsPort.existsSync(srcPkg)) {
      fsPort.copyFileSync(srcPkg, path.join(linkDir, 'package.json'));
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: makeError('ERR_INSTALL_FAILED', `path 源复制壳失败：${e.message}`) };
  }
}

/**
 * 安装 github 源插件：git clone，直连失败按 GITHUB_MIRRORS 前缀替换重试（FIX-17）。
 * @param {object} core
 * @param {object} plugin
 * @param {string} profile
 * @returns {Promise<{ok: boolean, error?: Error}>}
 */
async function installGithubPlugin(core, plugin, profile) {
  return installGithubPluginWithMirror(core, plugin, profile, null);
}

/**
 * github 安装 + 镜像重试链：explicitMirror 非空时只试该镜像（heal onMirror 用），
 * 否则先直连 github.com 再按 GITHUB_MIRRORS 依次重试。
 * @param {object} core
 * @param {object} plugin
 * @param {string} profile
 * @param {string|null} explicitMirror
 * @returns {Promise<{ok: boolean, channel?: string, mirror?: string, error?: Error}>}
 */
async function installGithubPluginWithMirror(core, plugin, profile, explicitMirror) {
  const procPort = core.ports.proc;
  const fsPort = core.ports.fs;
  const repo = plugin.source && plugin.source.repo;
  const ref = plugin.ref || 'main';
  const target = path.join(profile, 'node_modules', plugin.name);
  const directUrl = `https://github.com/${repo}.git`;
  const urls = explicitMirror
    ? [`${explicitMirror}${directUrl}`]
    : [directUrl, ...GITHUB_MIRRORS.map((m) => `${m}${directUrl}`)];

  let lastErr = null;
  for (const url of urls) {
    try {
      fsPort.mkdirSync(path.dirname(target), { recursive: true });
      if (fsPort.existsSync(target)) fsPort.rmSync(target, { recursive: true, force: true });
    } catch (e) {
      lastErr = makeError('ERR_INSTALL_ACQUIRE', `github 目标目录准备失败：${e.message}`);
      continue;
    }
    let gr;
    try {
      gr = procPort.spawnSync('git', ['clone', '--depth', '1', '--branch', ref, url, target], {
        stdio: 'pipe',
        encoding: 'utf8'
      });
    } catch (e) {
      lastErr = makeError('ERR_INSTALL_ACQUIRE', `git clone 无法执行：${e.message}`);
      continue;
    }
    if (gr.error || gr.status !== 0) {
      const msg = (gr.error && gr.error.message) || (gr.stderr || '').slice(0, 500);
      // C6 修复：透传真实 git 退出码（childExitCode），语义与 npm 通道一致。
      lastErr = makeError('ERR_INSTALL_ACQUIRE', `git clone 失败：${msg}`, { childExitCode: gr.status === null ? 1 : gr.status });
      continue;
    }
    if (!fsPort.existsSync(path.join(target, 'package.json'))) {
      lastErr = makeError('ERR_INSTALL_ACQUIRE', `clone 产物缺少 package.json：${repo}`);
      continue;
    }
    return { ok: true, channel: 'github', mirror: url };
  }
  return { ok: false, error: lastErr || makeError('ERR_INSTALL_ACQUIRE', `git clone 失败：${repo}`) };
}

/**
 * 批量安装插件。
 * @param {object} core
 * @param {Array<object>} plugins resolved 插件
 * @param {object} opts
 * @param {string} opts.profile
 * @returns {Promise<{ok: boolean, result?: object, error?: Error}>}
 */
async function installPlugins(core, plugins, opts) {
  const profile = opts.profile;
  const fsPort = core.ports.fs;
  const channels = [];
  for (const p of plugins || []) {
    let r;
    if (p.source.type === 'npm') {
      r = await installNpmPlugin(core, p, profile);
    } else if (p.source.type === 'path') {
      r = installPathPlugin(core, p, profile);
    } else {
      r = await installGithubPlugin(core, p, profile);
    }
    if (!r.ok) return { ok: false, error: r.error };
    channels.push({ name: p.name, channel: r.channel || p.source.type });
  }
  const nodeModules = fsPort.existsSync(path.join(profile, 'node_modules'));
  return { ok: true, result: { channels, nodeModules } };
}

/**
 * 安装产物校验。
 * @param {object} core
 * @param {Array<object>} plugins
 * @param {string} profile
 * @returns {{ok: boolean, missing?: Array<string>}}
 */
function verifyInstall(core, plugins, profile) {
  const fsPort = core.ports.fs;
  const missing = [];
  for (const p of plugins || []) {
    const nm = path.join(profile, 'node_modules', p.name);
    if (!fsPort.existsSync(nm)) missing.push(p.name);
  }
  return { ok: missing.length === 0, missing };
}

module.exports = { installPlugins, verifyInstall, installNpmPlugin, installPathPlugin, installGithubPlugin, installGithubPluginWithMirror };
