# 重新编译 DSH-Hotplug-Hub-Setup.exe（独立安装程序，内嵌主程序与 WebView2 运行 DLL）
# 用法: pwsh -File build-setup.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$srcDir = Join-Path $root 'src'
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "找不到 csc.exe: $csc" }

$setup = Join-Path $srcDir 'Setup.cs'
$appExe = Join-Path $root 'DSH-Hotplug-Hub.exe'
$coreDll = Join-Path $root 'Microsoft.Web.WebView2.Core.dll'
$winFormsDll = Join-Path $root 'Microsoft.Web.WebView2.WinForms.dll'
$loaderDll = Join-Path $root 'WebView2Loader.dll'
$out = Join-Path $root 'DSH-Hotplug-Hub-Setup.exe'

if (-not (Test-Path $setup)) { throw "找不到 Setup.cs: $setup" }
foreach ($f in @($appExe, $coreDll, $winFormsDll, $loaderDll)) {
  if (-not (Test-Path $f)) { throw "找不到安装负载文件: $f" }
}

$args = @(
  '/nologo', '/target:winexe', '/optimize+',
  "/out:$out",
  "/win32icon:$srcDir\app.ico",
  "/resource:$appExe,DSHHotplugHub.Setup.app.exe",
  "/resource:$coreDll,DSHHotplugHub.Setup.core.dll",
  "/resource:$winFormsDll,DSHHotplugHub.Setup.winforms.dll",
  "/resource:$loaderDll,DSHHotplugHub.Setup.loader.dll",
  '/reference:System.Windows.Forms.dll',
  '/reference:System.Drawing.dll',
  $setup
)
& $csc $args
if ($LASTEXITCODE -ne 0) { throw "编译失败，exit=$LASTEXITCODE" }
Write-Output "OK: $out ($((Get-Item $out).Length) bytes)"
