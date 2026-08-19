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
# 检查 GitHub 最新版本
Write-Output "== 版本检查 =="
try {
  $pkgPath = Join-Path $repo 'dsh-hotplug-hub\package.json'
  if (Test-Path $pkgPath) {
    $pkg = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $current = $pkg.version
    $json = curl.exe -s --ssl-no-revoke --max-time 15 'https://api.github.com/repos/ARFCON/dsh-hotplug-hub/releases/latest' 2>$null | ConvertFrom-Json
    if ($json -and $json.tag_name) {
      $latest = $json.tag_name.TrimStart('v')
      if ($latest -ne $current) {
        $lv = [System.Version]::new($latest)
        $cv = [System.Version]::new($current)
        if ($lv -gt $cv) {
          Write-Output "⚠️ 有新版本 v$latest（当前 v$current），请更新客户端后再修改。"
        } else {
          Write-Output "✅ 本地已领先 v$current（GitHub Release 为 v$latest），可发布新 Release。"
        }
      } else {
        Write-Output "✅ 已是最新版本 v$current"
      }
    } else {
      Write-Output "（GitHub 暂无 Release，跳过版本检查）"
    }
  }
} catch {
  Write-Output "（版本检查失败，跳过）"
}
