# 寒霜注入工具 —— 打包便携版
# 编码：UTF-8 with BOM
# 入口：pack-portable.cmd

$ErrorActionPreference = 'Stop'

try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

$AppDir = $PSScriptRoot
Set-Location $AppDir

# ── 读取 .env.hanshuang ──
$envFile = Join-Path $AppDir '.env.hanshuang'
if (Test-Path $envFile) {
    Get-Content $envFile -Encoding UTF8 | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
            $i = $line.IndexOf('=')
            $k = $line.Substring(0, $i).Trim()
            $v = $line.Substring($i + 1).Trim()
            if ($k -and $v) { Set-Item -Path "env:$k" -Value $v }
        }
    }
}

# ── 兜底 ──
if (-not $env:ELECTRON_BUILDER_CACHE) {
    $env:ELECTRON_BUILDER_CACHE = 'E:\ReverseLabWorkspace\toolchain\electron-builder-cache'
}
if (-not $env:ELECTRON_BUILDER_BINARIES_MIRROR) {
    $env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
}
if (-not $env:electron_config_cache) {
    $env:electron_config_cache = 'E:\ReverseLabWorkspace\toolchain\electron-cache'
}

# 代理对 github 的 CONNECT 返 502，打包时全程绕开
$env:HTTP_PROXY  = ''
$env:HTTPS_PROXY = ''
$env:http_proxy  = ''
$env:https_proxy = ''
$env:ALL_PROXY   = ''
$env:all_proxy   = ''

# electron-builder 起子进程时若继承 ELECTRON_RUN_AS_NODE，会以纯 Node 模式运行而崩
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

if (-not (Test-Path $env:ELECTRON_BUILDER_CACHE)) {
    New-Item -ItemType Directory -Path $env:ELECTRON_BUILDER_CACHE -Force | Out-Null
}

Write-Host ''
Write-Host "  产物目录  $AppDir\release-electron"
Write-Host "  打包缓存  $env:ELECTRON_BUILDER_CACHE"
Write-Host ''

Write-Host '[1/2] 清理上次的中间产物...'
$out = Join-Path $AppDir 'release-electron'
foreach ($sub in @('win-unpacked', 'win-unpacked.tmp')) {
    $p = Join-Path $out $sub
    if (Test-Path $p) { Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue }
}
Get-ChildItem $out -Filter '*.7z' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
Get-ChildItem $out -Filter 'builder-*.yml' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
Write-Host '      已清理'

Write-Host '[2/2] 构建并打便携版...'
& pnpm build
if ($LASTEXITCODE -ne 0) { throw 'pnpm build 失败' }
& pnpm build:server
if ($LASTEXITCODE -ne 0) { throw 'pnpm build:server 失败' }
& npx electron-builder --win portable
if ($LASTEXITCODE -ne 0) { throw 'electron-builder 失败' }

Write-Host ''
Get-ChildItem $out -Filter '*.exe' | ForEach-Object {
    Write-Host ("  完成：{0}  ({1:N1} MB)" -f $_.Name, ($_.Length / 1MB))
}
