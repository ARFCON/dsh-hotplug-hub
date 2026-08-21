// install-plugins.mjs — 跨平台安装 dsh-memory-hub 到本地 DeepSeek Harness
//
// 使用官方 `dsh plugin --profile web add <tgz>` 安装（自动写 package.json
// dependencies 与 dsh.profile.bundles），不再复制目录或手写 cordis.patch.yml。
//
// 可选环境变量：
//   DSH_MEMORY_HUB_URL  自定义 tgz 下载地址（缺省使用 GitHub Release v0.9.7 资产）
//   DSH_PROFILE          目标 profile（缺省 web）
//   DSH_ALLOW_INSTALL_SCRIPTS=1  显式放行依赖 install scripts（R-v5-17 放行通道；
//                                缺省 npm_config_ignore_scripts=true 纵深防御）
//
// v5 安全修复（阶段 1）：
//   - M-47：删除 profile .npmrc 的 strict-ssl=false（TLS 校验不可静默关闭）；
//   - H-7：tarballUrl / profile 进 argv 前过 assertShellSafe(Url)（shared 契约）；
//   - R-v5-17：npm_config_ignore_scripts=true 默认 + 显式放行通道。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { assertShellSafe, assertShellSafeUrl } from '../packages/shared-core/security/shell.js'
import { resolveDshRoot } from '../packages/shared-core/contracts/constants.js'
import { sanitizeChildEnv } from '../packages/shared-core/security/net.js'

// 上游适配（H-1）：根域 = resolveDshRoot()（优先级 DSH_HOTPLUG_ROOT > DSH_HOME >
// ~/.dsh），profile 落其下；此前硬编码 ~/.dsh 无法在隔离/自定义根环境使用。
const dshRoot = resolveDshRoot(process.env).dshRoot
const home = os.homedir()
const profile = process.env.DSH_PROFILE || 'web'
const profileRoot = path.join(dshRoot, 'profiles', profile)
const pkgFile = path.join(profileRoot, 'node_modules', 'dsh-memory-hub', 'package.json')
const tarballUrl = process.env.DSH_MEMORY_HUB_URL ||
  'https://github.com/ARFCON/dsh-hotplug-hub/releases/download/v0.9.7/dsh-memory-hub-0.8.0-pre.tgz'

function installedVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
    return pkg.version || null
  } catch { return null }
}

// 从 tgz URL 文件名解析包版本：dsh-memory-hub-0.2.1.tgz → 0.2.1
function tarballVersion(url) {
  const m = /dsh-memory-hub-(\d+\.\d+\.\d+)\.tgz/.exec(url || '')
  return m ? m[1] : null
}

function findDshCli() {
  // 1) DSH Desktop 内置 bin.js（最可靠，优先）
  const base = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
  const builtin = path.join(base, 'Programs', 'DSH Desktop', 'resources', 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (fs.existsSync(builtin)) {
    return { bin: process.execPath, args: [builtin, 'plugin', '--profile', profile, 'add', tarballUrl] }
  }

  // 2) 根域下的内置 dsh（resolveDshRoot 语义，非硬编码 ~/.dsh）
  const alt = path.join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (fs.existsSync(alt)) {
    return { bin: process.execPath, args: [alt, 'plugin', '--profile', profile, 'add', tarballUrl] }
  }

  // 3) PATH 上的 dsh（Windows 用 cmd.exe /c，其余平台直接调用）
  if (process.platform === 'win32') {
    return { bin: 'cmd.exe', args: ['/c', 'dsh', 'plugin', '--profile', profile, 'add', tarballUrl] }
  }
  return { bin: 'dsh', args: ['plugin', '--profile', profile, 'add', tarballUrl] }
}

function runDshPluginAdd() {
  // H-7：URL / profile 进 argv 前过 shell 安全契约（白名单 + 无元字符）
  const urlCheck = assertShellSafeUrl(tarballUrl, 'tarballUrl')
  if (!urlCheck.ok) {
    console.error('tarballUrl 非法：' + urlCheck.error.message)
    process.exit(2)
  }
  const profileCheck = assertShellSafe(profile, 'profile')
  if (!profileCheck.ok) {
    console.error('profile 非法：' + profileCheck.error.message)
    process.exit(2)
  }
  const ver = tarballVersion(tarballUrl)
  const installed = installedVersion()
  if (installed && ver && installed === ver) {
    console.log('already installed: dsh-memory-hub@' + installed)
    return
  }
  const { bin, args } = findDshCli()
  console.log('run:', bin, args.join(' '))
  // R-v5-17：安装脚本 RCE 纵深防御——默认 ignore-scripts，显式放行通道
  // DSH_ALLOW_INSTALL_SCRIPTS=1（dsh-memory-hub 无 install scripts，放行无副作用）
  // M-3（安全审计）：子进程 env 经 sanitizeChildEnv 净化——NODE_OPTIONS /
  // NODE_TLS_REJECT_UNAUTHORIZED / CA / SSL 变量不泄漏进安装进程（否则父环境被
  // 污染时可注入代码或静默关闭 tarball 下载的 TLS 校验）。
  const allowScripts = process.env.DSH_ALLOW_INSTALL_SCRIPTS === '1'
  const spawnEnv = sanitizeChildEnv(process.env)
  if (!allowScripts) spawnEnv.npm_config_ignore_scripts = 'true'
  const r = spawnSync(bin, args, { stdio: 'inherit', cwd: home, env: spawnEnv })
  if (r.error) {
    console.error('failed to run dsh plugin add:', r.error.message)
    process.exit(1)
  }
  if (r.status !== 0) {
    console.error('dsh plugin add exited with code', r.status)
    process.exit(r.status || 1)
  }
  const after = installedVersion()
  console.log('installed: dsh-memory-hub@' + (after || ver || 'unknown'))
}

runDshPluginAdd()
