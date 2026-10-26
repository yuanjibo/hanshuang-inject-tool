# 寒霜注入工具 —— 开发服务启动器
# 编码：UTF-8 with BOM（PowerShell 5.1 读中文需 BOM）
# 入口：start-hanshuang.cmd（纯 ASCII，只负责调起本文件）

$ErrorActionPreference = 'Stop'

# 控制台统一 UTF-8，否则中文经管道 / 重定向会变乱码
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

# ── 默认值兜底（.env.hanshuang 缺失时仍能跑） ──
if (-not $env:HANSHUANG_HOME) { $env:HANSHUANG_HOME = 'E:\ReverseLabWorkspace\home' }
if (-not $env:CODEX_HOME)     { $env:CODEX_HOME     = 'E:\AppData\Codex' }
if (-not $env:SEEP_PYTHON)    { $env:SEEP_PYTHON    = 'E:\Learning\Python\python.exe' }
if (-not $env:SEEP_ROOT)      { $env:SEEP_ROOT      = 'E:\ReverseLabWorkspace\seep-reverse-lab' }

# ── 绕开本机代理：它对 github / registry.npmjs.org 连通性差 ──
$env:HTTP_PROXY  = ''
$env:HTTPS_PROXY = ''
$env:http_proxy  = ''
$env:https_proxy = ''
$env:ALL_PROXY   = ''
$env:all_proxy   = ''

# ── electron 二进制 / 打包工具链：国内镜像 + E 盘缓存 ──
$ElectronCache = 'E:\ReverseLabWorkspace\toolchain\electron-cache'
$BuilderCache  = 'E:\ReverseLabWorkspace\toolchain\electron-builder-cache'

if (-not $env:ELECTRON_MIRROR)       { $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/' }
if (-not $env:ELECTRON_CUSTOM_DIR)   { $env:ELECTRON_CUSTOM_DIR = 'v{{ version }}' }
if (-not $env:electron_config_cache) { $env:electron_config_cache = $ElectronCache }

# electron-builder 默认把 nsis / winCodeSign / 7zip 写到 %LOCALAPPDATA%，改到 E 盘
if (-not $env:ELECTRON_BUILDER_CACHE) { $env:ELECTRON_BUILDER_CACHE = $BuilderCache }
if (-not $env:ELECTRON_BUILDER_BINARIES_MIRROR) {
    $env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
}

if (-not (Test-Path "$env:HANSHUANG_HOME\.cc-switch")) { New-Item -ItemType Directory -Path "$env:HANSHUANG_HOME\.cc-switch" -Force | Out-Null }
if (-not (Test-Path $ElectronCache)) { New-Item -ItemType Directory -Path $ElectronCache -Force | Out-Null }
if (-not (Test-Path $BuilderCache))  { New-Item -ItemType Directory -Path $BuilderCache -Force | Out-Null }

Write-Host ''
Write-Host "  项目目录    $AppDir"
Write-Host "  数据根      $env:HANSHUANG_HOME"
Write-Host "  数据实际落  $env:HANSHUANG_HOME\.cc-switch"
Write-Host "  Codex 配置  $env:CODEX_HOME"
Write-Host "  Seep 解释器 $env:SEEP_PYTHON"
Write-Host ''

# ── [1/3] 依赖 ──
if (Test-Path 'node_modules\vite\package.json') {
    Write-Host '[1/3] 依赖已就绪'
} else {
    Write-Host '[1/3] 安装依赖...'
    & pnpm install
    if ($LASTEXITCODE -ne 0) { throw 'pnpm install 失败' }
}

# ── [2/3] electron 二进制 ──
if (Test-Path 'node_modules\electron\path.txt') {
    Write-Host '[2/3] electron 已就绪'
} else {
    Write-Host '[2/3] 解压 electron 二进制...'
    & node 'node_modules\electron\install.js'
    if ($LASTEXITCODE -ne 0) { throw 'electron 解压失败' }
}

# ── [3/3] 启动 ──
Write-Host '[3/3] 启动 http://localhost:5190'
Write-Host '      关闭本窗口即停止服务'
Write-Host ''
& pnpm dev
