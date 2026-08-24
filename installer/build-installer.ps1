# 编译 DSH-Hotplug-Hub 安装程序 Setup.exe
# 用法: pwsh -File installer/build-installer.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$installer = Join-Path $root 'installer'
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "找不到 csc.exe: $csc" }
$main = Join-Path $installer 'Setup.cs'
$contract = Join-Path $installer '..\release\src\InstallUninstallContract.cs'
$out = Join-Path $installer 'Setup.exe'
$icon = Join-Path $installer '..\release\src\app.ico'
$args = @(
  '/nologo', '/target:winexe', '/optimize+',
  "/out:$out",
  "/win32icon:$icon",
  '/reference:System.Windows.Forms.dll',
  '/reference:System.Drawing.dll',
  '/reference:System.IO.Compression.dll',
  '/reference:System.IO.Compression.FileSystem.dll',
  $main,
  $contract
)
& $csc $args
if ($LASTEXITCODE -ne 0) { throw "编译失败，exit=$LASTEXITCODE" }
Write-Output "OK: $out ($((Get-Item $out).Length) bytes)"