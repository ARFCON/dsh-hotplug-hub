# 构建 DSH-Hotplug-Hub 卸载程序
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File build-uninstaller.ps1
$ErrorActionPreference = 'Stop'

$uninstallerDir = Split-Path -Parent $MyInvocation.MyCommand.Path
# 本脚本位于 uninstaller/hotplug-hub/，项目根需上溯两级
$projectRoot = Split-Path -Parent (Split-Path -Parent $uninstallerDir)
$src = Join-Path $uninstallerDir 'Uninstall_Hotplug_Hub.cs'
$contract = Join-Path $projectRoot 'release\src\InstallUninstallContract.cs'
$icon = Join-Path $projectRoot 'release\src\app.ico'
$tmpOut = Join-Path $uninstallerDir 'Uninstall_Hotplug_Hub_new.exe'
$finalOut = Join-Path $uninstallerDir 'Uninstall_Hotplug_Hub.exe'

$fwDir = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319"
$csc = Join-Path $fwDir 'csc.exe'
if (-not (Test-Path $csc)) {
    $csc = "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
}
if (-not (Test-Path $csc)) { throw "找不到 csc.exe" }

# 确保源文件带 UTF-8 BOM（csc.exe 依赖 BOM 正确读取中文字符串）
$bytes = [System.IO.File]::ReadAllBytes($src)
if (-not ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)) {
    $content = [System.IO.File]::ReadAllText($src, [System.Text.Encoding]::UTF8)
    $utf8Bom = New-Object System.Text.UTF8Encoding($true)
    [System.IO.File]::WriteAllText($src, $content, $utf8Bom)
    Write-Host "已为源文件添加 UTF-8 BOM"
}

Write-Host "编译: $src"
& $csc /nologo /target:winexe "/out:$tmpOut" "/r:$fwDir\System.Windows.Forms.dll" "/r:$fwDir\System.Drawing.dll" "/r:$fwDir\System.Management.dll" $src $contract
if ($LASTEXITCODE -ne 0) { throw "编译失败, exit=$LASTEXITCODE" }

Write-Host "嵌入图标: $icon"
powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $uninstallerDir 'embed-icon-in-exe.ps1') -ExePath $tmpOut -IconPath $icon
if ($LASTEXITCODE -ne 0) { throw "嵌入图标失败, exit=$LASTEXITCODE" }

Move-Item -Force $tmpOut $finalOut

$item = Get-Item $finalOut
Write-Host "完成: $($item.FullName)  size=$($item.Length)  time=$($item.LastWriteTime)"