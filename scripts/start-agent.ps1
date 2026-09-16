# 启动「连接手机的那台主机」上的 Agent。
#
# ⚠️ 本文件必须保存为「UTF-8 带 BOM」。
#    Windows PowerShell 5.1 在没有 BOM 时会按 GBK 解码本文件，
#    中文注释会变成乱码，并引发看起来毫无道理的语法错误
#    （例如报「缺少右大括号」，但大括号其实是对的）。
#    用 VS Code 保存时选 "UTF-8 with BOM"。
#
# 用法：
#   .\scripts\start-agent.ps1
#
# 覆盖默认值：
#   .\scripts\start-agent.ps1 -RelayUrl "ws://1.2.3.4:5081/ws/agent" -AgentId "pc-02"
#   .\scripts\start-agent.ps1 -Secret "<与服务器 relay 相同的 AGENT_SECRET>"
#
# 设计说明：脚本**不写死 adb / scrcpy 的本机路径**，只负责检查环境变量是否就位，
# 缺了就打印出该设什么。这样同一份脚本在任何机器上都能用，
# 也不会把个人机器的路径提交进仓库。

[CmdletBinding()]
param(
    [string]$RelayUrl = "",
    [string]$AgentId = "",
    [string]$DeviceRange = "",
    [string]$Secret = "",
    [string]$MediaDir = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path $PSScriptRoot -Parent

function Get-EffectiveEnv {
    param([string]$Name)

    # 当前进程优先，其次读用户级持久变量
    $value = [Environment]::GetEnvironmentVariable($Name, "Process")
    if (-not $value) {
        $value = [Environment]::GetEnvironmentVariable($Name, "User")
    }
    return $value
}

function Get-ArgOrEnv {
    param([string]$ArgValue, [string]$EnvName, [string]$Default)

    if ($ArgValue) { return $ArgValue }

    $fromEnv = Get-EffectiveEnv $EnvName
    if ($fromEnv) { return $fromEnv }

    return $Default
}

Write-Host "===== Remote Phone Control · Agent =====" -ForegroundColor Cyan
Write-Host ""

# ── 1. 检查工具路径 ─────────────────────────────────────────────
$missing = @()

foreach ($name in @("ADB_PATH", "SCRCPY_PATH", "SCRCPY_SERVER_PATH")) {
    $value = Get-EffectiveEnv $name

    if (-not $value) {
        $missing += $name
        Write-Host "  [缺失] $name" -ForegroundColor Red
        continue
    }

    # scrcpy-server 是无扩展名的文件，adb/scrcpy 是可执行文件，都用 Test-Path 判断
    if (-not (Test-Path $value)) {
        Write-Host "  [路径不存在] $name = $value" -ForegroundColor Yellow
        continue
    }

    # 写回当前进程，确保子进程（npm → tsx）能继承
    Set-Item -Path "env:$name" -Value $value
    Write-Host "  [就绪] $name" -ForegroundColor Green
}

if ($missing.Count -gt 0) {
    Write-Host ""
    Write-Host "缺少环境变量：$($missing -join ', ')" -ForegroundColor Red
    Write-Host ""
    Write-Host "设一次即可（持久生效，之后要开新窗口才看得到）：" -ForegroundColor Yellow
    Write-Host '  setx ADB_PATH           "C:\path\to\platform-tools\adb.exe"'
    Write-Host '  setx SCRCPY_PATH        "C:\path\to\scrcpy.exe"'
    Write-Host '  setx SCRCPY_SERVER_PATH "C:\path\to\scrcpy-server"'
    Write-Host ""
    Write-Host "或者只在本窗口临时设：" -ForegroundColor Yellow
    Write-Host '  $env:ADB_PATH = "C:\path\to\platform-tools\adb.exe"'
    Write-Host '  $env:SCRCPY_PATH = "C:\path\to\scrcpy.exe"'
    Write-Host '  $env:SCRCPY_SERVER_PATH = "C:\path\to\scrcpy-server"'
    Write-Host ""
    exit 1
}

# ── 2. 中继地址 ────────────────────────────────────────────────
$effectiveRelay = Get-ArgOrEnv $RelayUrl "RELAY_SERVER_WS_URL" ""
if (-not $effectiveRelay) {
    Write-Host ""
    Write-Host "未指定中继地址。" -ForegroundColor Red
    Write-Host "  用法一：.\scripts\start-agent.ps1 -RelayUrl `"ws://<服务器>:5081/ws/agent`""
    Write-Host "  用法二：先设 `$env:RELAY_SERVER_WS_URL，再运行本脚本"
    Write-Host ""
    exit 1
}

Set-Item -Path "env:RELAY_SERVER_WS_URL" -Value $effectiveRelay

# ── 3. 其余配置（有默认值）─────────────────────────────────────
$effectiveAgentId = Get-ArgOrEnv $AgentId "AGENT_ID" "agent-local"
Set-Item -Path "env:AGENT_ID" -Value $effectiveAgentId

$effectiveRange = Get-ArgOrEnv $DeviceRange "DEVICE_TCP_RANGE" ""
if ($effectiveRange) {
    Set-Item -Path "env:DEVICE_TCP_RANGE" -Value $effectiveRange
}

Write-Host "  [就绪] RELAY_SERVER_WS_URL = $effectiveRelay" -ForegroundColor Green
Write-Host "  [就绪] AGENT_ID = $effectiveAgentId" -ForegroundColor Green

if ($effectiveRange) {
    Write-Host "  [就绪] DEVICE_TCP_RANGE = $effectiveRange" -ForegroundColor Green
} else {
    Write-Host "  [关闭] 未设置 DEVICE_TCP_RANGE —— 设备保活不会启用" -ForegroundColor Yellow
}

# ── 3.5 发视频用：共享密钥与暂存目录 ───────────────────────────
# 这两项**只影响「发视频」**：养号、看画面、操控都不依赖它们。
# 所以缺了不中止启动，但必须显式警告 —— 否则这份「就绪」清单会让人
# 以为一切正常，直到客户下发视频才发现下载 401，排查方向还容易跑偏
# （表现是「视频发不出去」，实际原因在启动参数里）。
$effectiveSecret = Get-ArgOrEnv $Secret "AGENT_SECRET" ""
if ($effectiveSecret) {
    Set-Item -Path "env:AGENT_SECRET" -Value $effectiveSecret
    # 只报长度，不把密钥本身打到屏幕上/日志里
    Write-Host "  [就绪] AGENT_SECRET（已设置，$($effectiveSecret.Length) 位）" -ForegroundColor Green
} else {
    Write-Host "  [缺失] AGENT_SECRET —— 发视频会失败（下载视频时报 401/503）" -ForegroundColor Yellow
    Write-Host '         设一次即可（持久生效）：' -ForegroundColor Yellow
    Write-Host '           setx AGENT_SECRET "<与服务器 relay 上完全相同的密钥>"' -ForegroundColor Yellow
    Write-Host '         服务器上生成：openssl rand -hex 32' -ForegroundColor Yellow
}

$effectiveMedia = Get-ArgOrEnv $MediaDir "MEDIA_DIR" ""
if ($effectiveMedia) {
    Set-Item -Path "env:MEDIA_DIR" -Value $effectiveMedia
    Write-Host "  [就绪] MEDIA_DIR = $effectiveMedia" -ForegroundColor Green
} else {
    Write-Host "  [默认] MEDIA_DIR 未设置，将用 %TEMP%\remote-phone-media" -ForegroundColor Yellow
    Write-Host '         每个视频都会在本机留一份，建议放到非系统盘：' -ForegroundColor Yellow
    Write-Host '           setx MEDIA_DIR "D:\remote-phone-media"' -ForegroundColor Yellow
}

Write-Host ""
Write-Host "启动中……" -ForegroundColor Cyan
Write-Host ""

# ── 4. 启动 ────────────────────────────────────────────────────
Push-Location $repoRoot
try {
    npm run agent:server
} finally {
    Pop-Location
}
