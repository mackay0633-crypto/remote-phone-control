# 停掉这台主机上的 Agent。
#
# ⚠️ 本文件必须保存为「UTF-8 带 BOM」（同 start-agent.ps1）：
#    PowerShell 5.1 在没有 BOM 时按 GBK 解码，中文注释变乱码并引发
#    看起来毫无道理的语法错误。
#
# 用法：
#   .\scripts\stop-agent.ps1              # 按端口找到 agent 并结束整条进程链
#   .\scripts\stop-agent.ps1 -Port 5072   # 非默认端口
#
# ── 为什么需要它 ────────────────────────────────────────────────
#
# `-Background` 启动的 agent 没有窗口，没法再靠 Ctrl+C 停。
# 而它的进程链是 cmd → npm → cmd → npm → node(tsx) → node(agent) 好几层，
# 在任务管理器里手动找那一个「node.exe」很容易杀错（这台机器上可能同时跑着
# 编辑器、浏览器调试服务等好几个 node）。
#
# 这里从**监听端口反查属主**，只杀占着 AGENT_PORT 的那条链：
# 先结束 Agent 本体，它一退出上面几层 npm/cmd 自然跟着退；
# 再顺手清掉可能残留的 cmd 包装进程。

[CmdletBinding()]
param(
    [int]$Port = 0
)

$ErrorActionPreference = "Stop"

function Resolve-AgentPort {
    param([int]$Explicit)

    if ($Explicit -gt 0) { return $Explicit }

    foreach ($scope in @("User", "Process")) {
        $value = [Environment]::GetEnvironmentVariable("AGENT_PORT", $scope)
        if ($value) {
            $parsed = 0
            if ([int]::TryParse($value, [ref]$parsed) -and $parsed -gt 0) { return $parsed }
        }
    }

    return 5071
}

$targetPort = Resolve-AgentPort $Port

Write-Host "===== 停止 Agent =====" -ForegroundColor Cyan
Write-Host "  端口: $targetPort"
Write-Host ""

$listeners = Get-NetTCPConnection -LocalPort $targetPort -State Listen -ErrorAction SilentlyContinue

if (-not $listeners) {
    Write-Host "  端口 $targetPort 上没有进程在监听 —— agent 本来就没在跑。" -ForegroundColor Yellow
    return
}

# 变量名别用 $pid：PowerShell 里它是只读的当前进程 ID
$ownerPid = $listeners[0].OwningProcess
$owner = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue

if ($owner) {
    Write-Host "  Agent 本体: pid=$ownerPid  $($owner.ProcessName)  启动于 $($owner.StartTime)" -ForegroundColor Gray
} else {
    Write-Host "  Agent 本体: pid=$ownerPid（已退出，端口可能正要释放）" -ForegroundColor Gray
}

# /T 连子进程一起结束；/F 强制（agent 没有需要优雅收尾的持久状态）
& taskkill.exe /PID $ownerPid /T /F 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }

# 后台模式外面还套了一层 `cmd /c npm run agent:serve >> ...`。上面杀掉 Agent
# 之后它通常自己就退了，但保险起见按命令行精确匹配清一次 —— 只匹配我们自己
# 那个写法，不会误伤别的 node/cmd。
Start-Sleep -Seconds 2
$wrappers = Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*agent:serve*" }

foreach ($wrapper in $wrappers) {
    Write-Host "  清理残留包装进程: pid=$($wrapper.ProcessId)" -ForegroundColor DarkGray
    & taskkill.exe /PID $wrapper.ProcessId /T /F 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
}

Start-Sleep -Seconds 1
$still = Get-NetTCPConnection -LocalPort $targetPort -State Listen -ErrorAction SilentlyContinue

Write-Host ""
if ($still) {
    Write-Host "  [未停干净] 端口 $targetPort 仍在监听（pid=$($still[0].OwningProcess)）" -ForegroundColor Red
    Write-Host "             可能是权限不足，用管理员身份重跑本脚本。" -ForegroundColor Red
} else {
    Write-Host "  [已停止] 端口 $targetPort 已释放。" -ForegroundColor Green
}
