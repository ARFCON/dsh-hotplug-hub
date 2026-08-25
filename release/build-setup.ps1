# 重新编译 DSH-Hotplug-Hub-Setup.exe（独立安装程序，内嵌主程序、WebView2 运行 DLL 与卸载器）
# 用法: pwsh -File build-setup.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$srcDir = Join-Path $root 'src'
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "找不到 csc.exe: $csc" }

# v1.1（PC19）：先重编主程序——此前本脚本只检查 EXE「存在性」，可能把过期 EXE 打进 Setup。
& (Join-Path $root 'build-exe.ps1')
if ($LASTEXITCODE -ne 0) { throw "build-exe.ps1 失败，中止打包 Setup" }

$setup = Join-Path $srcDir 'Setup.cs'
$appExe = Join-Path $root 'DSH-Hotplug-Hub.exe'
$coreDll = Join-Path $root 'Microsoft.Web.WebView2.Core.dll'
$winFormsDll = Join-Path $root 'Microsoft.Web.WebView2.WinForms.dll'
$loaderDll = Join-Path $root 'WebView2Loader.dll'
# v1.1（PC21）：随装卸载器（uninstaller/hotplug-hub），ARP 的 UninstallString 指向它
$uninstallerExe = Join-Path $root '..\uninstaller\hotplug-hub\Uninstall_Hotplug_Hub.exe'
$out = Join-Path $root 'DSH-Hotplug-Hub-Setup.exe'

if (-not (Test-Path $setup)) { throw "找不到 Setup.cs: $setup" }
foreach ($f in @($appExe, $coreDll, $winFormsDll, $loaderDll, $uninstallerExe)) {
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
  "/resource:$uninstallerExe,DSHHotplugHub.Setup.uninstall.exe",
  '/reference:System.Windows.Forms.dll',
  '/reference:System.Drawing.dll',
  $setup
)
& $csc $args
if ($LASTEXITCODE -ne 0) { throw "编译失败，exit=$LASTEXITCODE" }
Write-Output "OK: $out ($((Get-Item $out).Length) bytes)"
