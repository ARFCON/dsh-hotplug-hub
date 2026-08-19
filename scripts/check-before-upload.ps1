# check-before-upload.ps1 — 上传前检查修改内容是否有错误
# 用法: pwsh -File scripts/check-before-upload.ps1
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$git = 'C:\Program Files\Git\cmd\git.exe'
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