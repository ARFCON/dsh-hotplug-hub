# _git.ps1 — git 可执行文件探测（内部 helper，供其他脚本 dot-source 使用）
# 用法: . (Join-Path $PSScriptRoot '_git.ps1'); $git = Get-GitExe
# 解析顺序：环境变量 GIT > PATH 中的 git > 常见安装路径。
# 说明：先替换各脚本里写死的 'C:\Program Files\Git\cmd\git.exe'，
#       使脚本在 git 安装于任意位置的机器（含便携版）都能自动找到。

function Get-GitExe {
  # 1. 环境变量 GIT 显式覆盖（最灵活，可指向任意便携 git.exe）
  if ($env:GIT) {
    if (Test-Path $env:GIT) { return $env:GIT }
    Write-Warning "环境变量 GIT 已设置但路径不存在: $env:GIT ，继续探测其他位置"
  }

  # 2. PATH 中可直接调用的 git
  $cmd = Get-Command git.exe -ErrorAction SilentlyContinue
  if (-not $cmd) { $cmd = Get-Command git -ErrorAction SilentlyContinue }
  if ($cmd) {
    if ($cmd.CommandType -eq 'Application' -and $cmd.Source) { return $cmd.Source }
    if ($cmd.Path) { return $cmd.Path }
  }

  # 3. 常见安装路径回退
  $candidates = @(
    (Join-Path $env:ProgramFiles 'Git\cmd\git.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Git\cmd\git.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Git\cmd\git.exe'),
    (Join-Path $env:LOCALAPPDATA 'Git\cmd\git.exe'),
    'C:\Git\cmd\git.exe'
  ) | Where-Object { $_ -and (Test-Path $_) }
  if ($candidates) { return $candidates[0] }

  return $null
}

# 找不到 git 时给出可操作的报错（-Path 传 null 就 exit 1）
function Assert-GitExe {
  param($Path)
  if (-not $Path) {
    Write-Error "未找到 git。请安装 Git for Windows，或设置环境变量 GIT 指向 git.exe 的完整路径（如便携版 MinGit）。"
    exit 1
  }
}
