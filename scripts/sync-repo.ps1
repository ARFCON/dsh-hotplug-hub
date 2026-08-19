# sync-repo.ps1 — 修改前自动同步远程仓库到工作文件夹
# 用法: pwsh -File scripts/sync-repo.ps1
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$git = 'C:\Program Files\Git\cmd\git.exe'
if (-not (Test-Path (Join-Path $repo '.git'))) { Write-Error "不是 Git 仓库: $repo"; exit 1 }

Write-Output "== 同步仓库: $repo =="

# 1. 获取远程更新
& $git -C $repo fetch origin 2>&1 | Out-String

# 2. 检查本地与远程差异
$local = (& $git -C $repo rev-parse HEAD 2>$null).Trim()
$remote = (& $git -C $repo rev-parse origin/main 2>$null).Trim()
if (-not $remote) {
  Write-Output "远程 origin/main 不存在，跳过自动拉取。"
  exit 0
}

if ($local -eq $remote) {
  Write-Output "仓库已是最新，无需拉取。"
} else {
  Write-Output "检测到远程有更新，正在拉取..."
  & $git -C $repo pull --ff-only origin main 2>&1 | Out-String
  Write-Output "拉取完成。"
}

# 3. 显示当前状态
Write-Output "== 当前状态 =="
& $git -C $repo status --short --branch 2>&1 | Out-String