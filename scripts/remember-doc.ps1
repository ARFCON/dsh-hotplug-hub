# remember-doc.ps1 — 读取开发文档后写入全局记忆
# 用法: pwsh -File scripts/remember-doc.ps1 -DocPath 开发文档/团队/共同开发文档.md
param(
  [Parameter(Mandatory=$true)][string]$DocPath
)
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$full = Join-Path $repo $DocPath
if (-not (Test-Path $full)) { Write-Error "找不到文档: $full"; exit 1 }

$content = Get-Content $full -Raw -Encoding UTF8
$summary = $content.Substring(0, [Math]::Min(200, $content.Length)) -replace "`r?`n", ' '

$memoryDir = Join-Path $env:USERPROFILE '.dsh\memory'
$memoryFile = Join-Path $memoryDir 'memories.jsonl'
New-Item -ItemType Directory -Force -Path $memoryDir | Out-Null

$entry = [ordered]@{
  type = 'doc-read'
  team = 'dsh-hotplug-hub'
  doc = $DocPath
  at = (Get-Date).ToUniversalTime().ToString('o')
  reader = $env:USERNAME
  summary = $summary
} | ConvertTo-Json -Compress

Add-Content -Path $memoryFile -Value $entry -Encoding UTF8
Write-Output "已写入全局记忆: $memoryFile"
Write-Output "条目: $entry"