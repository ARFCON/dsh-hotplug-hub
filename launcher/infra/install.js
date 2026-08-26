'use strict';
// infra/install.js — 插件安装（npm 直装 sandbox / path 建 link / github clone）
//
// 审计修复：B（插件源从不落地）— npm 源进 dependencies 并安装；
// github/path 源校验目标存在并建 link。副作用全部经端口注入。
const path = require('path');
const { GITHUB_MIRRORS } = require('../contracts/constants');
const { makeError } = require('../contracts/errors');
const { CMD_EXE_SPECIAL_RE, resolveCmdBin } = require('./dsh-cli');
const { copyDirRecursive } = require('./copy-dir');
const { sanitizeChildEnv } = require('@dsh/shared-core/security/net');

/**
 * 安装 npm 插件：npm install 以 cwd=<profile> 直装到 sandbox，并校验落地。
 * @param {object} core
 * @param {object} plugin resolved 插件
 * @param {string} profile 安装目标目录（sandbox）
 * @returns {Promise<{ok: boolean, channel?: string, error?: Error}>}
 */
async function installNpmPlugin(core, plugin, profile) {
  const procPort = core.ports.proc;
  const fsPort = core.ports.fs;
  const version = plugin.resolvedVersion || plugin.version;

  // 审计修复（A/B，根治）：「dsh plugin add 通道」与本 launcher 的 sandbox 前置架构
  // 互斥，已整体移除：
  //   - dsh plugin add 面向【命名 profile】（~/.dsh/profiles/<name>），而本模块的
  //     install 落地目标是【sandbox 目录】（sbDir，由 stageInstall 传入的 profile 参数）；
  //     把 sbDir 全文路径当 --profile 名传给 dsh CLI 会使其 resolveProfileDir 遇路径
  //     分隔符即抛错（主通道恒崩溃后静默降级，属死代码 + 环境有 dsh 无 npm 时的假失败）。
  //   - 该通道成功返回后【不校验 node_modules/<name> 是否真正落地】（与下方 npm 通道
  //     的落地校验不对称），可造成「INSTALL OK 但 node_modules 为空」的假成功。
  //   故收敛为：npm install 以 cwd=<sandbox> 直装，落地后必须校验 node_modules/<name>。
  // C6 修复：win32 下 npm 是 npm.cmd，spawnSync('npm') 直接执行返回 ENOENT——
  // 通道在 Windows 恒失败；经 cmd.exe /c 包装。
  // R3（审查修复）：cmd 解释器统一走 resolveCmdBin（ComSpec/System32 绝对路径）——
  // 此前裸 'cmd.exe' 与 findDshCli 的加固不一致（PATH 被隔离时 ENOENT）。
  const spec = version ? `${plugin.name}@${version}` : plugin.name;
  const isWin = core.config.platform === 'win32';
  const npmBin = isWin ? resolveCmdBin(core) : 'npm';
  const npmArgs = isWin
    ? ['/c', 'npm', 'install', '--no-audit', '--no-fund', spec]
    : ['install', '--no-audit', '--no-fund', spec];
  let sr;
  try {
    // M-2（安全审计）：npm 子进程 env 净化（防 NODE_OPTIONS 注入 / TLS 静默关闭）；
    // 显式传 env 后子进程不再隐式继承 process.env，npm_config_* 用户配置仍保留。
    sr = procPort.spawnSync(npmBin, npmArgs, {
      cwd: profile,
      stdio: 'pipe',
      encoding: 'utf8',
      env: sanitizeChildEnv(core.config.env || process.env)
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
  // 校验落地（与 github 通道对称：不仅存在目录，还须存在 package.json——npm 退出 0
  // 却产出空目录/桩目录时不应被判「落地成功」）
  const nm = path.join(profile, 'node_modules', plugin.name);
  if (!fsPort.existsSync(path.join(nm, 'package.json'))) {
    return { ok: false, error: makeError('ERR_INSTALL_DEP', `安装后 node_modules/${plugin.name} 不存在或缺少 package.json`) };
  }
  return { ok: true, channel: 'npm' };
}

/**
 * 安装 path 源插件：校验目标存在 + 建立真实链接（junction/dir-symlink）。
 * C6 + 审计 C 修复：此前链接失败只回退「复制壳」（仅复制 package.json，插件 main 入口
 * 代码缺失，DSH require 后无法加载，属假成功）。现在优先建链接；链接不可用时回退
 * 递归目录复制（插件代码真正落地）并返回 note（显式可观测，不静默）。
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
        // 链接失败（EINVAL/EPERM/不支持）→ 回退目录复制，note 显式记录
        const fallback = copyDirRecursive(fsPort, target, linkDir);
        return fallback.ok
          ? { ok: true, note: `链接失败已回退目录复制（${linkErr.message}）` }
          : fallback;
      }
    }
    const fallback = copyDirRecursive(fsPort, target, linkDir);
    return fallback.ok
      ? { ok: true, note: '环境不支持链接，已使用目录复制' }
      : fallback;
  } catch (e) {
    // C6 修复：mkdir/copy 失败（EACCES/ENOSPC/名称被占）映射语义错误码，不裸抛 FATAL
    return { ok: false, error: makeError('ERR_INSTALL_FAILED', `path 源安装失败 ${plugin.name}：${e.message}`) };
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
  // 审计修复（m8 空白根因）：git clone 把目标路径作为 cmd /c 的位置参数传入时，含空白的
  // 绝对路径会被 cmd 按空白切分成多个参数（与 npm 通道遇到的同一问题）。npm 通道已用
  // cwd 选项规避；git 通道改为【cwd=<profile> + 相对目标 node_modules/<name>】——相对
  // 目标仅由白名单校验过的 plugin.name 构成（PLUGIN_NAME_RE 无空白/无 cmd 特殊字符），
  // 彻底消除「本地路径含空格」导致的参数切分破坏，且不改动落地位置语义。
  const relTarget = path.join('node_modules', plugin.name);
  const isWin = core.config.platform === 'win32';
  // C6 修复（QA4 实证）：与 npm 降级通道对称——win32 下 git 可能以 git.cmd/.bat
  // 形态存在（shim 安装），spawnSync('git') 直接执行返回 ENOENT，须经 cmd.exe /c
  // 包装。参数中的 cmd 特殊字符显式拒绝（libuv 会把内嵌引号转义为 \" 导致 cmd
  // 无法解析——防命令注入/引号破坏，宁可报错也不静默注入）。
  // m8（安全审计）：repo/ref 另拒空白——cmd /c 下空白会改变参数切分（repo/ref
  // 本就不含空白，拒绝无害）；相对目标由 plugin.name 派生（无空白），同样显式校验防御。
  if (isWin) {
    for (const part of [repo, ref, relTarget]) {
      if (CMD_EXE_SPECIAL_RE.test(String(part)) || /\s/.test(String(part))) {
        return { ok: false, error: makeError('ERR_INSTALL_ACQUIRE', `git 参数含 cmd 特殊字符/空白，拒绝经 cmd 执行：${part}`) };
      }
    }
  }
  // R3（审查修复）：同 npm 降级通道——cmd 解释器走 resolveCmdBin 绝对路径
  const gitBin = isWin ? resolveCmdBin(core) : 'git';
  // 审计修复（F）：ref 为 40 位十六进制提交 SHA 时，`--depth 1` 的浅克隆无法解析
  // detached SHA（git clone --depth 1 --branch <sha> 恒失败）——去掉 --depth 做全量克隆
  // 才能 checkout 该提交。普通分支/tag ref 保持浅克隆（省流量）。
  const isShaRef = /^[0-9a-f]{40}$/i.test(String(ref || ''));
  const gitBaseArgs = isShaRef ? ['clone', '--branch', ref] : ['clone', '--depth', '1', '--branch', ref];
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
      // M-2（安全审计）：git 子进程 env 净化（同 npm 通道）；显式传 env，
      // git 凭据/代理等用户配置仍保留（仅删可削弱 TLS / 可注入的变量）。
      // m8 修复：cwd=<profile> + 相对目标（本地路径含空格不再破坏 cmd 参数切分）。
      gr = procPort.spawnSync(gitBin, isWin ? ['/c', 'git', ...gitBaseArgs, url, relTarget] : [...gitBaseArgs, url, relTarget], {
        cwd: profile,
        stdio: 'pipe',
        encoding: 'utf8',
        env: sanitizeChildEnv(core.config.env || process.env)
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
  const notes = [];
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
    // 审计 C 修复：透传各通道的 note（如「链接失败已回退目录复制」）——此前被静默丢弃，
    // 上层对「插件以降级形态落地」零感知。
    if (r.note) notes.push({ name: p.name, note: r.note });
  }
  const nodeModules = fsPort.existsSync(path.join(profile, 'node_modules'));
  return { ok: true, result: { channels, nodeModules, notes } };
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
    // 与 installNpmPlugin / installGithubPlugin 的落地校验口径一致：不仅要求目录存在，
    // 还要求 package.json 存在（空目录/桩目录不算落地成功）。
    if (!fsPort.existsSync(path.join(nm, 'package.json'))) missing.push(p.name);
  }
  return { ok: missing.length === 0, missing };
}

module.exports = { installPlugins, verifyInstall, installNpmPlugin, installPathPlugin, installGithubPlugin, installGithubPluginWithMirror };
