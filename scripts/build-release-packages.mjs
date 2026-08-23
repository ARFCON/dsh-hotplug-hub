#!/usr/bin/env node
/**
 * scripts/build-release-packages.mjs — 构建 6 个发布资产：
 *   Windows x64  安装版（Setup exe）+ 便携版（zip）
 *   Linux   x64  安装版（自解压 .sh）+ 便携版（tar.gz）
 *   macOS   x64  安装版（自解压 .command）+ 便携版（zip）
 * 两个自有插件（dseam-skillmcp / dsh-hub）随包内置在 plugins/ 目录。
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const version = '1.0.3'
const releaseDir = join(root, 'release')
const distDir = join(releaseDir, 'dist')
const uiFile = join(root, 'dsh-hotplug-hub', 'dsh-pack-hub', 'prototype.html')
const embeddedDir = join(releaseDir, 'embedded')
const plugins = [
  'dseam-skillmcp-0.8.1-pre.tgz',
  'dsh-hub-1.1.8.tgz',
]
const winDlls = [
  'Microsoft.Web.WebView2.Core.dll',
  'Microsoft.Web.WebView2.WinForms.dll',
  'WebView2Loader.dll',
]

function sh(...args) {
  let cmdArgs = args.slice(1);
  if (cmdArgs.length === 1 && Array.isArray(cmdArgs[0])) cmdArgs = cmdArgs[0];
  const r = spawnSync(args[0], cmdArgs, { stdio: 'inherit' })
  if (r.status !== 0) {
    process.exit(r.status == null ? 1 : r.status)
  }
}
function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true })
}
function copy(src, dst) {
  ensureDir(join(dst, '..'))
  copyFileSync(src, dst)
}
function writeText(p, text, eol = '\n') {
  ensureDir(join(p, '..'))
  writeFileSync(p, text.replace(/\r?\n/g, eol))
}
function fileSize(p) {
  return statSync(p).size
}
function winForwardPath(p) {
  return p.replace(/\\/g, '/')
}
function posixPath(p) {
  return p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1').toLowerCase()
}

rmSync(distDir, { recursive: true, force: true })
ensureDir(distDir)

// ---------- 共享 shell 脚本 ----------
const linuxLauncher = [
  '#!/usr/bin/env bash',
  '# DSH-Hotplug-Hub Linux 便携版启动器（浏览器打开内置 UI）',
  'set -euo pipefail',
  'cd "$(dirname "$0")"',
  'if command -v xdg-open >/dev/null 2>&1; then',
  '  xdg-open "ui/prototype.html"',
  'elif command -v open >/dev/null 2>&1; then',
  '  open "ui/prototype.html"',
  'else',
  '  echo "请用浏览器打开 ui/prototype.html"',
  'fi',
].join('\n') + '\n'

const installPluginsSh = [
  '#!/usr/bin/env bash',
  '# 安装内置三插件到本地 DSH profile（需要 dsh CLI）',
  'set -euo pipefail',
  'cd "$(dirname "$0")"',
  'if command -v dsh >/dev/null 2>&1; then',
  '  for f in plugins/*.tgz; do',
  '    echo "== 安装 $f"',
  '    dsh plugin --profile web add "$f" || echo "跳过: $f"',
  '  done',
  '  echo "完成。重启 DSH Desktop 后生效。"',
  'else',
  '  echo "未检测到 dsh CLI；插件已内置在 plugins/ 目录，可稍后手动安装。"',
  'fi',
].join('\n') + '\n'

const readmeLinux = [
  'DSH-Hotplug-Hub Linux x64 便携版 v' + version,
  '=========================================',
  '启动：双击/执行 dsh-hotplug-hub（或在终端 ./dsh-hotplug-hub）。',
  '插件：plugins/ 目录已内置三插件，执行 ./install-plugins.sh 可安装到 DSH。',
  '注意：首次运行如被系统拦截，请在终端执行：chmod +x dsh-hotplug-hub install-plugins.sh',
].join('\n') + '\n'

// ---------- Linux 便携版 tar.gz ----------
const linuxFolder = 'DSH-Hotplug-Hub-linux-x64-portable'
const linuxStage = join(distDir, linuxFolder)
ensureDir(join(linuxStage, 'ui'))
ensureDir(join(linuxStage, 'plugins'))
copy(uiFile, join(linuxStage, 'ui', 'prototype.html'))
for (const f of plugins) copy(join(embeddedDir, f), join(linuxStage, 'plugins', f))
writeText(join(linuxStage, 'dsh-hotplug-hub'), linuxLauncher)
writeText(join(linuxStage, 'install-plugins.sh'), installPluginsSh)
writeText(join(linuxStage, 'README.txt'), readmeLinux)
const linuxTar = join(distDir, linuxFolder + '-v' + version + '.tar.gz')
const posixDist = posixPath(distDir)
const linuxTarRel = posixDist + '/' + linuxFolder + '-v' + version + '.tar.gz'
sh('tar', ['-czf', linuxTarRel, '-C', posixDist, linuxFolder])

// ---------- Linux 安装版（自解压 .sh，内含 tar.gz） ----------
const linuxSetup = join(distDir, 'DSH-Hotplug-Hub-linux-x64-setup-v' + version + '.sh')
const linuxSetupHeader = [
  '#!/usr/bin/env bash',
  '# DSH-Hotplug-Hub Linux x64 安装脚本（自解压）',
  'set -euo pipefail',
  'INSTALL_DIR="${HOME}/.local/share/dsh-hotplug-hub"',
  'BIN_DIR="${HOME}/.local/bin"',
  'APPS_DIR="${HOME}/.local/share/applications"',
  'mkdir -p "${INSTALL_DIR}" "${BIN_DIR}" "${APPS_DIR}"',
  'SKIP=$(awk \'/^__PAYLOAD__$/ { print NR + 1; exit 0 }\' "$0")',
  'tail -n +"${SKIP}" "$0" | tar -xz -C "${INSTALL_DIR}" --strip-components=1',
  'chmod +x "${INSTALL_DIR}/dsh-hotplug-hub" "${INSTALL_DIR}/install-plugins.sh" 2>/dev/null || true',
  'ln -sf "${INSTALL_DIR}/dsh-hotplug-hub" "${BIN_DIR}/dsh-hotplug-hub"',
  'cat > "${APPS_DIR}/dsh-hotplug-hub.desktop" <<\'DESKTOP\'',
  '[Desktop Entry]',
  'Type=Application',
  'Name=DSH Hotplug Hub',
  'Name[zh_CN]=DSH 热插拔中枢',
  'Comment=DSH 热插拔中枢（内置插件）',
  'Exec=' + '${HOME}/.local/bin/dsh-hotplug-hub',
  'Icon=applications-development',
  'Terminal=false',
  'Categories=Development;Utility;',
  'DESKTOP',
  'echo "已安装到 ${INSTALL_DIR}；启动器：${BIN_DIR}/dsh-hotplug-hub"',
  'exit 0',
  '__PAYLOAD__',
].join('\n') + '\n'
writeFileSync(linuxSetup, Buffer.concat([Buffer.from(linuxSetupHeader, 'utf8'), readFileSync(linuxTar)]))

// ---------- macOS 便携版 zip ----------
const macFolder = 'DSH-Hotplug-Hub-macos-x64-portable'
const macStage = join(distDir, macFolder)
ensureDir(join(macStage, 'ui'))
ensureDir(join(macStage, 'plugins'))
copy(uiFile, join(macStage, 'ui', 'prototype.html'))
for (const f of plugins) copy(join(embeddedDir, f), join(macStage, 'plugins', f))
const macLauncher = [
  '#!/bin/bash',
  '# DSH-Hotplug-Hub macOS 便携版启动器（默认浏览器打开内置 UI）',
  'cd "$(dirname "$0")"',
  'open "ui/prototype.html"',
].join('\n') + '\n'
writeText(join(macStage, 'Start-DSH-Hotplug-Hub.command'), macLauncher)
writeText(join(macStage, 'install-plugins.sh'), installPluginsSh)
writeText(join(macStage, 'README.txt'), [
  'DSH-Hotplug-Hub macOS x64 便携版 v' + version,
  '=========================================',
  '启动：双击 Start-DSH-Hotplug-Hub.command。',
  '插件：plugins/ 目录已内置三插件，执行 ./install-plugins.sh 可安装到 DSH。',
  '注意：首次运行如被 Gatekeeper 拦截，请右键该文件选择“打开”。',
].join('\n') + '\n')
const macZip = join(distDir, macFolder + '-v' + version + '.zip')
sh('pwsh', ['-NoProfile', '-Command',
  "Compress-Archive -LiteralPath '" + winForwardPath(macStage) + "' -DestinationPath '" + winForwardPath(macZip) + "' -Force"])

// ---------- macOS 安装版（自解压 .command，内含 base64 zip） ----------
const macSetup = join(distDir, 'DSH-Hotplug-Hub-macos-x64-setup-v' + version + '.command')
const macSetupHeader = [
  '#!/bin/bash',
  '# DSH-Hotplug-Hub macOS x64 安装脚本（自解压）',
  'set -euo pipefail',
  'APP_ROOT="${HOME}/Applications"',
  'mkdir -p "${APP_ROOT}"',
  'TMP=$(mktemp -d)',
  'SKIP=$(awk \'/^__PAYLOAD__$/ { print NR + 1; exit 0 }\' "$0")',
  'tail -n +"${SKIP}" "$0" | openssl base64 -d -A > "$TMP/portable.zip"',
  'unzip -o "$TMP/portable.zip" -d "${APP_ROOT}" >/dev/null',
  'chmod +x "${APP_ROOT}/' + macFolder + '/Start-DSH-Hotplug-Hub.command" "${APP_ROOT}/' + macFolder + '/install-plugins.sh" 2>/dev/null || true',
  'rm -rf "$TMP"',
  'echo "已安装到 ${APP_ROOT}/' + macFolder + '；正在打开…"',
  'open "${APP_ROOT}/' + macFolder + '"',
  'exit 0',
  '__PAYLOAD__',
].join('\n') + '\n'
writeFileSync(macSetup, Buffer.concat([Buffer.from(macSetupHeader, 'utf8'), Buffer.from(readFileSync(macZip).toString('base64'), 'utf8')]))

// ---------- Windows 便携版 zip ----------
const winFolder = 'DSH-Hotplug-Hub-win-x64-portable'
const winStage = join(distDir, winFolder)
ensureDir(join(winStage, 'plugins'))
copy(join(releaseDir, 'DSH-Hotplug-Hub.exe'), join(winStage, 'DSH-Hotplug-Hub.exe'))
for (const d of winDlls) copy(join(releaseDir, d), join(winStage, d))
for (const f of plugins) copy(join(embeddedDir, f), join(winStage, 'plugins', f))
writeText(join(winStage, 'README.txt'), [
  'DSH-Hotplug-Hub Windows x64 便携版 v' + version,
  '===============================================',
  '启动：双击 DSH-Hotplug-Hub.exe。',
  '首次运行会自动把内置三插件（Skill/MCP 管理器、全局记忆、插件中枢）',
  '安装到本机 DSH profile，之后随应用版本一起更新。',
  'plugins/ 目录为内置插件备份，供高级用户手动安装。',
].join('\r\n') + '\r\n', '\r\n')
const winZip = join(distDir, winFolder + '-v' + version + '.zip')
sh('pwsh', ['-NoProfile', '-Command',
  "Compress-Archive -LiteralPath '" + winForwardPath(winStage) + "' -DestinationPath '" + winForwardPath(winZip) + "' -Force"])

// ---------- Windows 安装版（重命名 Setup exe） ----------
const winSetup = join(distDir, 'DSH-Hotplug-Hub-win-x64-setup-v' + version + '.exe')
copy(join(releaseDir, 'DSH-Hotplug-Hub-Setup.exe'), winSetup)

// ---------- 输出清单 ----------
console.log('== 发布资产 ==')
for (const f of [winSetup, winZip, linuxTar, linuxSetup, macZip, macSetup]) {
  console.log(f + '  (' + fileSize(f) + ' bytes)')
}
