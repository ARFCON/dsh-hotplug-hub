# download-runtime.ps1 — 下载安装程序内置的全局运行时负载（node + pnpm）到 installer/runtime/
# 用法: pwsh -File installer/download-runtime.ps1
# 产物: installer/runtime/node.zip + installer/runtime/pnpm.zip
#       这两个 zip 由 Setup.exe 在安装时自动解压并部署为全局 node / pnpm（见 Setup.cs DeployRuntime）。
#       负载不进 git（.gitignore 排除 installer/runtime/），由本脚本在打包分发包前生成。
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
$proxy = 'http://127.0.0.1:7890'

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$handler = New-Object System.Net.Http.HttpClientHandler
if ($proxy) { $handler.Proxy = New-Object System.Net.WebProxy($proxy) }
$handler.AllowAutoRedirect = $true
$client = New-Object System.Net.Http.HttpClient($handler)
$client.Timeout = [TimeSpan]::FromMinutes(10)
$client.DefaultRequestHeaders.TryAddWithoutValidation('User-Agent', 'dsh-hotplug-hub-runtime') | Out-Null

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
}

Write-Output '--- installer/runtime/ ---'
Get-ChildItem $dst | Select-Object Name, Length
