# remember-doc.ps1 — 读取开发文档后写入全局记忆
# 用法: pwsh -File scripts/remember-doc.ps1 -DocPath 开发文档/团队/共同开发文档.md
#
# v5 安全修复：
#   - H-15：$DocPath 拒绝绝对路径与 '..' 穿越；Resolve-Path 后校验仍在 $repo 内；
#   - M-40 / R-v5-14：记忆根对齐 resolveDshRoot()/memory-hub（DSH_HOME 优先，
#     缺省 ~/.dsh/memory-hub），与 dsh-memory-hub 插件记忆根一致。
param(
  [Parameter(Mandatory=$true)][string]$DocPath
)
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

# H-15：输入校验——拒绝绝对路径 / 盘符 / UNC / '..' 段
if ([IO.Path]::IsPathRooted($DocPath) -or $DocPath -match '(^|[\\/])\.\.[\\/]') {
  Write-Error "文档路径非法（拒绝绝对路径与 .. 穿越）: $DocPath"; exit 1
}
$full = Join-Path $repo $DocPath
if (-not (Test-Path -LiteralPath $full)) { Write-Error "找不到文档: $full"; exit 1 }
# H-15：Resolve-Path 后校验真实路径仍在 $repo 内（防符号链接/归一化绕过）
$repoResolved = (Resolve-Path -LiteralPath $repo).Path.TrimEnd([IO.Path]::DirectorySeparatorChar)
$resolved = (Resolve-Path -LiteralPath $full).Path
if (-not $resolved.StartsWith($repoResolved + [IO.Path]::DirectorySeparatorChar)) {
  Write-Error "文档路径越界（不在仓库内）: $DocPath"; exit 1
}

$content = Get-Content -LiteralPath $resolved -Raw -Encoding UTF8
$summary = $content.Substring(0, [Math]::Min(200, $content.Length)) -replace "`r?`n", ' '

# M-40 / R-v5-14：记忆根 = resolveDshRoot()/memory-hub（优先级 DSH_HOTPLUG_ROOT >
# DSH_HOME > ~/.dsh——上游适配：DSH_HOTPLUG_ROOT 设定时整个根域落其下）
$dshRoot = if ($env:DSH_HOTPLUG_ROOT) { Join-Path $env:DSH_HOTPLUG_ROOT '.dsh' }
  elseif ($env:DSH_HOME) { $env:DSH_HOME }
  else { Join-Path $env:USERPROFILE '.dsh' }
$memoryDir = Join-Path $dshRoot 'memory-hub'
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
# 同步提交到 memory-hub 插件（走协议，进提案队列）
$commitScript = Join-Path $repo 'scripts\memoryhub-commit.mjs'
$docName = Split-Path -Leaf $DocPath
try {
  $out = node $commitScript 'global.project' $docName $summary 2>&1 | Out-String
  Write-Output $out.Trim()
} catch {
  Write-Output '（memory-hub 提交失败，已保留 memories.jsonl 兼容写入）'
}
