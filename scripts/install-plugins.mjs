// install-plugins.mjs — 跨平台安装 dsh-memory-hub 到本地 DeepSeek Harness
//
// 使用官方 `dsh plugin --profile web add <tgz>` 安装（自动写 package.json
// dependencies 与 dsh.profile.bundles），不再复制目录或手写 cordis.patch.yml。
//
// 可选环境变量：
//   DSH_MEMORY_HUB_URL  自定义 tgz 下载地址（缺省使用 GitHub Release v0.9.4 资产）
//   DSH_PROFILE          目标 profile（缺省 web）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const home = os.homedir()
const profile = process.env.DSH_PROFILE || 'web'
const profileRoot = path.join(home, '.dsh', 'profiles', profile)
const pkgFile = path.join(profileRoot, 'node_modules', 'dsh-memory-hub', 'package.json')
const tarballUrl = process.env.DSH_MEMORY_HUB_URL ||
  'https://github.com/ARFCON/dsh-hotplug-hub/releases/download/v0.9.4/dsh-memory-hub-0.8.0-pre.tgz'

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

function ensureProfileNpmrc() {
  try {
    fs.mkdirSync(profileRoot, { recursive: true })
    const npmrc = path.join(profileRoot, '.npmrc')
    const line = 'strict-ssl=false'
    const text = fs.existsSync(npmrc) ? fs.readFileSync(npmrc, 'utf8') : ''
    if (!text.includes(line)) {
      fs.appendFileSync(npmrc, (text.endsWith('\n') ? '' : '\n') + line + '\n')
    }
  } catch (e) {
    console.log('warn: cannot write .npmrc:', e.message)
  }
}

function findDshCli() {
  // 1) DSH Desktop 内置 bin.js（最可靠，优先）
  const base = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
  const builtin = path.join(base, 'Programs', 'DSH Desktop', 'resources', 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (fs.existsSync(builtin)) {
    return { bin: process.execPath, args: [builtin, 'plugin', '--profile', profile, 'add', tarballUrl] }
  }

  // 2) ~/.dsh 下的内置 dsh
  const alt = path.join(home, '.dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
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
  const ver = tarballVersion(tarballUrl)
  const installed = installedVersion()
  if (installed && ver && installed === ver) {
    console.log('already installed: dsh-memory-hub@' + installed)
    return
  }
  ensureProfileNpmrc()
  const { bin, args } = findDshCli()
  console.log('run:', bin, args.join(' '))
  const r = spawnSync(bin, args, { stdio: 'inherit', cwd: home })
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
