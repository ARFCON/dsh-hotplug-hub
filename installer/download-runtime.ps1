# download-runtime.ps1 — 下载安装程序内置的全局运行时负载（node + pnpm）到 installer/runtime/
# 用法: pwsh -File installer/download-runtime.ps1
# 产物: installer/runtime/node.zip + installer/runtime/pnpm.zip
#       这两个 zip 由 Setup.exe 在安装时自动解压并部署为全局 node / pnpm（见 Setup.cs DeployRuntime）。
#       负载不进 git（.gitignore 排除 installer/runtime/），由本脚本在打包分发包前生成。
#
# v5 供应链纵深防御（关联 M-39）：node 经 nodejs.org SHASUMS256.txt 校验；
# pnpm 经 GitHub Release 资产 pnpm-win32-x64.zip.sha256 校验；校验失败即中止。
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$dst = Join-Path $root 'installer\runtime'
New-Item -ItemType Directory -Path $dst -Force | Out-Null

# 固定版本（Node 与 .nvmrc 一致 = v22.19.0；pnpm 11.x）
$nodeVer = 'v22.19.0'
$pnpmVer = 'v11.22.0'
$urls = @{
  'node.zip' = "https://nodejs.org/dist/$nodeVer/node-$nodeVer-win-x64.zip"
  'pnpm.zip' = "https://github.com/pnpm/pnpm/releases/download/$pnpmVer/pnpm-win32-x64.zip"
}
# 代理（m9 安全审计）：不再硬编码本地代理——优先 DSH_RUNTIME_PROXY 环境变量，
# 缺省走系统代理（HttpClientHandler.UseProxy 默认 true）；显式 DSH_RUNTIME_PROXY=none
# 可强制直连。TLS 端到端校验恒开启（Tls12 + 默认证书验证，见 handler 配置）。
$proxy = if ($env:DSH_RUNTIME_PROXY -and $env:DSH_RUNTIME_PROXY -ne 'none') { $env:DSH_RUNTIME_PROXY } else { $null }

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$handler = New-Object System.Net.Http.HttpClientHandler
if ($proxy) { $handler.Proxy = New-Object System.Net.WebProxy($proxy) }
elseif ($env:DSH_RUNTIME_PROXY -eq 'none') { $handler.UseProxy = $false }
$handler.AllowAutoRedirect = $true
$client = New-Object System.Net.Http.HttpClient($handler)
$client.Timeout = [TimeSpan]::FromMinutes(10)
$client.DefaultRequestHeaders.TryAddWithoutValidation('User-Agent', 'dsh-hotplug-hub-runtime') | Out-Null

function Get-String([string]$url) {
  $req = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Get, $url)
  $resp = $client.SendAsync($req, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
  if (-not $resp.IsSuccessStatusCode) { throw "下载失败 HTTP $([int]$resp.StatusCode): $url" }
  try { return $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult() } finally { $resp.Dispose() }
}

# 期望 sha256（与官方校验文件比对）；取首个命中行
function Get-ExpectedSha256([string]$name, [string]$sumsText) {
  $line = ($sumsText -split "`r?`n") | Where-Object { $_ -match "\s$([regex]::Escape($name))$" } | Select-Object -First 1
  if (-not $line) { throw "校验文件中未找到 $name 的条目" }
  return ($line -split '\s+')[0].ToLowerInvariant()
}

# node：官方 SHASUMS256.txt（TLS 校验由 HttpClient 默认策略保证）
$nodeSums = Get-String "https://nodejs.org/dist/$nodeVer/SHASUMS256.txt"
$nodeExpected = Get-ExpectedSha256 "node-$nodeVer-win-x64.zip" $nodeSums

# pnpm：GitHub Release 资产 .sha256 文件（官方向量；不依赖第三方镜像）
$pnpmExpected = (Get-String "https://github.com/pnpm/pnpm/releases/download/$pnpmVer/pnpm-win32-x64.zip.sha256").Trim().Split(' ')[0].ToLowerInvariant()
if ($pnpmExpected -notmatch '^[0-9a-f]{64}$') { throw "pnpm sha256 文件格式异常: $pnpmExpected" }

$expected = @{
  'node.zip' = $nodeExpected
  'pnpm.zip' = $pnpmExpected
}

foreach ($name in @('node.zip', 'pnpm.zip')) {
  $url = $urls[$name]
  $dest = Join-Path $dst $name
  Write-Output "下载 $name ..."
  $req = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Get, $url)
  $resp = $client.SendAsync($req, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
  if (-not $resp.IsSuccessStatusCode) { throw "$name 下载失败 HTTP $([int]$resp.StatusCode): $url" }
  $fs = [IO.File]::Create($dest)
  try { $resp.Content.ReadAsStreamAsync().GetAwaiter().GetResult().CopyTo($fs) } finally { $fs.Dispose() }
  Write-Output ("  OK: {0} ({1} bytes)" -f $dest, (Get-Item $dest).Length)

  # SHA256 校验：失败即删除并中止（供应链纵深防御，关联 M-39）
  $hash = (Get-FileHash -Path $dest -Algorithm SHA256).Hash.ToLowerInvariant()
  $want = $expected[$name]
  if ($hash -ne $want) {
    Remove-Item -LiteralPath $dest -Force
    throw "$name SHA256 不匹配（期望 $want，实际 $hash）——已删除损坏负载，请重试"
  }
  Write-Output "  SHA256 OK: $hash"
}

Write-Output '--- installer/runtime/ ---'
Get-ChildItem $dst | Select-Object Name, Length
