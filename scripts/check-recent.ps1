# check-recent.ps1 — 检查目标文件最近是否被修改过
# 用法: pwsh -File scripts/check-recent.ps1 -Path launcher/index.js
param(
  [Parameter(Mandatory=$true)][string]$Path
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$git = 'C:\Program Files\Git\cmd\git.exe'

Write-Output "== 最近提交记录: $Path =="
& $git -C $repo log --oneline -10 -- $Path 2>&1 | Out-String

Write-Output "== 工作区状态 =="
& $git -C $repo status --short 2>&1 | Out-String

Write-Output "== 建议 =="
Write-Output "如果最近 3 次提交有其他人改过，先沟通再修改。"