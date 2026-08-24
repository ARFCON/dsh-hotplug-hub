# 重新编译 DSH-Hotplug-Hub.exe（WinForms + WebView2 桌面版）
# 用法: pwsh -File build-exe.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$srcDir = Join-Path $root 'src'
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "找不到 csc.exe: $csc" }

$protoHtml = Join-Path $root '..\dsh-hotplug-hub\dsh-pack-hub\prototype.html'
$embeddedSkillmcpTgz = Join-Path $root 'embedded/dseam-skillmcp-0.8.1-pre.tgz'
$embeddedMemoryHubTgz = Join-Path $root 'embedded/dsh-memory-hub-0.8.0-pre.tgz'
$embeddedDshHubTgz = Join-Path $root 'embedded/dsh-hub-1.1.8.tgz'
$main = Join-Path $srcDir 'Main.cs'
# v5（crosslang 重构）：Main.cs 引用 PatchContract（锁/分节/字符集契约），必须同编译单元
$patchContract = Join-Path $srcDir 'PatchContract.cs'
# 托盘/窗口状态契约（ShellContract）同样与 Main.cs 同编译单元
$shellContract = Join-Path $srcDir 'ShellContract.cs'
# 配置修复契约（RepairContract：settings.yaml 去重 / .credentials.yaml 扁平化）
$repairContract = Join-Path $srcDir 'RepairContract.cs'
$out = Join-Path $root 'DSH-Hotplug-Hub.exe'

# WebView2 托管 DLL 与原生 Loader（从本机 Office/OfficePLUS 复制，避免联网）
# WebView2 DLL 来源：优先使用环境变量（CI 可注入），否则使用本机 Office/OfficePLUS 路径
$coreDllSrc = $env:WEBVIEW2_CORE_DLL
$winFormsDllSrc = $env:WEBVIEW2_WINFORMS_DLL
$loaderSrc = $env:WEBVIEW2_LOADER_DLL
if (-not $coreDllSrc) { $coreDllSrc = 'C:\Program Files\Microsoft Office\root\Office16\ADDINS\Microsoft Power Query for Excel Integrated\bin\Microsoft.Web.WebView2.Core.dll' }
if (-not $winFormsDllSrc) { $winFormsDllSrc = 'C:\Program Files\Microsoft Office\root\Office16\ADDINS\Microsoft Power Query for Excel Integrated\bin\Microsoft.Web.WebView2.WinForms.dll' }
if (-not $loaderSrc) { $loaderSrc = 'C:\Program Files\Microsoft Office\root\Office16\WebView2Loader.dll' }
$coreDll = Join-Path $root 'Microsoft.Web.WebView2.Core.dll'
$winFormsDll = Join-Path $root 'Microsoft.Web.WebView2.WinForms.dll'
$loaderDll = Join-Path $root 'WebView2Loader.dll'
foreach ($pair in @(@($coreDllSrc,$coreDll), @($winFormsDllSrc,$winFormsDll), @($loaderSrc,$loaderDll))) {
  if (-not (Test-Path $pair[0])) { throw "找不到 $($pair[0])" }
  Copy-Item $pair[0] $pair[1] -Force
}

if (-not (Test-Path $protoHtml)) { throw "找不到 prototype.html: $protoHtml" }
if (-not (Test-Path $embeddedSkillmcpTgz)) { throw "找不到内置 Skill/MCP 管理器包: $embeddedSkillmcpTgz" }
if (-not (Test-Path $embeddedMemoryHubTgz)) { throw "找不到内置全局记忆插件包: $embeddedMemoryHubTgz" }
if (-not (Test-Path $embeddedDshHubTgz)) { throw "找不到内置插件中枢包: $embeddedDshHubTgz" }

$args = @(
  '/nologo', '/target:winexe', '/optimize+',
  "/out:$out",
  "/win32icon:$srcDir\app.ico",
  "/resource:$protoHtml,DSHHotplugHub.Resources.prototype.html",
    "/resource:$embeddedSkillmcpTgz,DSHHotplugHub.Resources.dseam_skillmcp.tgz"
  "/resource:$embeddedMemoryHubTgz,DSHHotplugHub.Resources.dsh_memory_hub.tgz"
  "/resource:$embeddedDshHubTgz,DSHHotplugHub.Resources.dsh_hub.tgz"
  "/reference:$winFormsDll",
  "/reference:$coreDll",
  '/reference:System.Windows.Forms.dll',
  '/reference:System.Drawing.dll',
  '/reference:System.Web.Extensions.dll',
  $main,
  $patchContract,
  $shellContract,
  $repairContract
)
& $csc $args
if ($LASTEXITCODE -ne 0) { throw "编译失败，exit=$LASTEXITCODE" }
Write-Output "OK: $out ($((Get-Item $out).Length) bytes)"