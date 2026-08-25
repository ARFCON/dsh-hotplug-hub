# check-before-upload.ps1 — 上传前检查修改内容是否有错误
# 用法: pwsh -File scripts/check-before-upload.ps1
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
. (Join-Path $PSScriptRoot '_git.ps1')
$git = Get-GitExe
Assert-GitExe $git
$failed = @()

function Step($name, [scriptblock]$block) {
  Write-Output "== $name =="
  try {
    & $block
    Write-Output "OK: $name"
  } catch {
    Write-Output "FAIL: $name -> $($_.Exception.Message)"
    $script:failed += $name
  }
}

# 1. 同步远程仓库
Step '同步远程仓库' {
  & (Join-Path $repo 'scripts\sync-repo.ps1')
}

# 2. 启动器 CLI 测试
Step '启动器 assemble 测试' {
  Push-Location $repo
  try { node launcher/index.js assemble example | Out-Null } finally { Pop-Location }
}
Step '启动器 check 测试' {
  Push-Location $repo
  try { node launcher/index.js check example | Out-Null } finally { Pop-Location }
}
Step '启动器 heal 测试' {
  Push-Location $repo
  try { node launcher/index.js heal example | Out-Null } finally { Pop-Location }
}

# 3.5 版本号一致性检查（v1.1 PC18：package.json / Main.cs / Setup.cs 同源）
Step '版本号一致性检查' {
  Push-Location $repo
  try { node scripts/check-version-consistency.mjs | Out-Null } finally { Pop-Location }
}

# 3.6 注入脚本健壮性验收（v1.1 PC15：桌面壳注入 JS 页面半失败不级联）
Step '注入脚本健壮性验收（qa13）' {
  Push-Location $repo
  try { node scripts/qa13-shell-injection.mjs | Out-Null } finally { Pop-Location }
}

# 3. PowerShell 脚本语法检查
Step 'PowerShell 脚本语法检查' {
  $psFiles = Get-ChildItem (Join-Path $repo 'scripts') -Filter '*.ps1' -File
  foreach ($f in $psFiles) {
    $tokens = $null; $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$tokens, [ref]$errors) | Out-Null
    if ($errors -and $errors.Count -gt 0) {
      throw "语法错误: $($f.Name) -> $($errors[0].Message)"
    }
  }
}

# 4. Git 空白/冲突检查
Step 'Git diff 检查' {
  & $git -C $repo diff --check 2>&1 | Out-String
  $status = & $git -C $repo status --short 2>&1 | Out-String
  Write-Output $status
}

if ($failed.Count -gt 0) {
  Write-Output ""
  Write-Output "❌ 检查未通过，请先修复再上传：$($failed -join ', ')"
  exit 1
} else {
  Write-Output ""
  Write-Output "✅ 所有检查通过，可以上传。"
}