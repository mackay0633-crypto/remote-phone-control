# 清理主机上累积的视频副本（<MEDIA_DIR>/<videoId>/）。
#
# ⚠️ 本文件必须保存为「UTF-8 带 BOM」（同 start-agent.ps1 / stop-agent.ps1）。
#
# 用法：
#   .\scripts\clean-agent-media.ps1                    # 只报告（预演），不改任何东西
#   .\scripts\clean-agent-media.ps1 -Apply             # 删掉超过 30 天的
#   .\scripts\clean-agent-media.ps1 -OlderThanDays 7 -Apply
#   .\scripts\clean-agent-media.ps1 -KeepNewestGB 5 -Apply   # 额外把总量压到 5GB 以内
#
# ── 为什么还需要这个脚本 ────────────────────────────────────────
#
# 新代码在**派发成功后会自动删掉本机副本**（`relay-client` 的 removeLocalCopies），
# 所以正常情况下 MEDIA_DIR 是空的。但仍然需要这个脚本，因为：
#
#   1. **历史遗留**：自动清理之前累积下来的目录还在
#   2. **失败路径故意保留**：派发失败时会留着副本便于排查，久了也会堆
#   3. relay 重启/断线导致任务中断时，副本可能没走到清理那一步
#
# ── 安全设计 ───────────────────────────────────────────────────
#
# 只处理**目录名是 32 位小写十六进制**（我们的 videoId 格式）的子目录。
# 这样即使 MEDIA_DIR 被误设成 D:\ 或 C:\Users，也不会误删无关目录 ——
# 名字不匹配的一律跳过并报出来。默认还是预演，必须显式 -Apply 才真删。

[CmdletBinding()]
param(
    [string]$MediaDir = "",
    [int]$OlderThanDays = 30,
    [double]$KeepNewestGB = 0,
    [switch]$Apply
)

$ErrorActionPreference = "Stop"

function Resolve-MediaDir {
    param([string]$Explicit)

    if ($Explicit) { return $Explicit }

    foreach ($scope in @("User", "Process")) {
        $value = [Environment]::GetEnvironmentVariable("MEDIA_DIR", $scope)
        if ($value) { return $value }
    }

    # 与 agent 的默认值一致（agent/src/config/env.ts）
    return (Join-Path $env:TEMP "remote-phone-media")
}

$root = Resolve-MediaDir $MediaDir

# ⚠️ 别用 PowerShell 7 的 `? :` 三元运算符 —— 本脚本要在 Windows PowerShell 5.1
#    （主机上默认就是它）下运行，5.1 解析不了那个语法。
$capNote = ""
if ($KeepNewestGB -gt 0) { $capNote = "，且总量压到 $KeepNewestGB GB 以内" }

# 按量级选单位：否则小文件会显示成「0 GB」，看着像没东西可清
function Format-Gb {
    param([double]$Gb)
    if ($Gb -ge 1) { return ("{0:N2} GB" -f $Gb) }
    return ("{0:N1} MB" -f ($Gb * 1024))
}

Write-Host "===== 清理主机视频副本 =====" -ForegroundColor Cyan
Write-Host "  目录: $root"
Write-Host "  策略: 超过 $OlderThanDays 天$capNote"
Write-Host "  模式: $(if ($Apply) { '实际删除' } else { '预演（不改动）' })"
Write-Host ""

if (-not (Test-Path $root)) {
    Write-Host "  目录不存在 —— 从没下载过视频，无需清理。" -ForegroundColor Yellow
    Write-Host "  （发视频成功时会创建它，成功后又会被自动删掉，所以它经常是不存在的。）"
    return
}

# 只认 32 位小写十六进制的目录名 —— 这是我们的 videoId 格式
$videoIdPattern = '^[0-9a-f]{32}$'

$allDirs = Get-ChildItem -Path $root -Directory -ErrorAction SilentlyContinue
$videoDirs = @()
$skipped = @()

foreach ($dir in $allDirs) {
    if ($dir.Name -match $videoIdPattern) {
        $videoDirs += $dir
    } else {
        $skipped += $dir.Name
    }
}

if ($skipped.Count -gt 0) {
    Write-Host "  跳过 $($skipped.Count) 个名字不像 videoId 的目录（不碰）：" -ForegroundColor DarkGray
    $skipped | Select-Object -First 5 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    if ($skipped.Count -gt 5) { Write-Host "    …（其余 $($skipped.Count - 5) 个略）" -ForegroundColor DarkGray }
    Write-Host ""
}

if ($videoDirs.Count -eq 0) {
    Write-Host "  ✓ 没有待清理的视频目录。" -ForegroundColor Green
    return
}

# 收集：大小 + 最后一次写入时间（用目录内最新的文件，比目录自身的 mtime 准）
$items = foreach ($dir in $videoDirs) {
    $files = Get-ChildItem -Path $dir.FullName -Recurse -File -ErrorAction SilentlyContinue
    $bytes = ($files | Measure-Object -Property Length -Sum).Sum
    if (-not $bytes) { $bytes = 0 }

    $lastWrite = if ($files) {
        ($files | Sort-Object LastWriteTime -Descending | Select-Object -First 1).LastWriteTime
    } else {
        $dir.LastWriteTime
    }

    [pscustomobject]@{
        Name      = $dir.Name
        Path      = $dir.FullName
        MB        = [math]::Round($bytes / 1MB, 1)
        LastWrite = $lastWrite
        AgeDays   = [math]::Round(((Get-Date) - $lastWrite).TotalDays, 1)
    }
}

$totalBytes = ($items | Measure-Object -Property MB -Sum).Sum
Write-Host "  视频目录 $($items.Count) 个，合计 $(Format-Gb ($totalBytes / 1024))" -ForegroundColor Gray

# ── 选候选：先按天数，再按容量 ──────────────────────────────────
$byAge = $items | Where-Object { $_.AgeDays -gt $OlderThanDays }
$candidates = @($byAge)

if ($KeepNewestGB -gt 0) {
    # 从最新的开始累加，超过上限的其余都算候选
    $budgetBytes = $KeepNewestGB * 1024
    $running = 0.0
    $overCap = @()
    foreach ($item in ($items | Sort-Object LastWrite -Descending)) {
        $running += $item.MB / 1024
        if ($running -gt $budgetBytes) { $overCap += $item }
    }

    $names = @($candidates | ForEach-Object { $_.Name }) + @($overCap | ForEach-Object { $_.Name })
    $candidates = @($items | Where-Object { $names -contains $_.Name })
}

if ($candidates.Count -eq 0) {
    Write-Host ""
    Write-Host "  ✓ 没有符合条件的目录（都还没超过 $OlderThanDays 天，也没超容量上限）。" -ForegroundColor Green
    return
}

$freeMB = [math]::Round((($candidates | Measure-Object -Property MB -Sum).Sum), 1)
Write-Host ""
Write-Host "  待清理 $($candidates.Count) 个，可释放约 $(Format-Gb ($freeMB / 1024))：" -ForegroundColor Yellow
$candidates | Sort-Object LastWrite | Select-Object -First 15 | ForEach-Object {
    Write-Host ("    {0}  {1,8:N1} MB  {2,7:N1} 天前" -f $_.Name, $_.MB, $_.AgeDays)
}
if ($candidates.Count -gt 15) { Write-Host "    …（其余 $($candidates.Count - 15) 个略）" }

if (-not $Apply) {
    Write-Host ""
    Write-Host "  （预演。确认无误后加 -Apply 真删）" -ForegroundColor Cyan
    Write-Host "    .\scripts\clean-agent-media.ps1 -OlderThanDays $OlderThanDays -Apply"
    return
}

Write-Host ""
Write-Host "  执行删除…" -ForegroundColor Cyan
$removed = 0
$failed = 0
foreach ($item in $candidates) {
    try {
        Remove-Item -LiteralPath $item.Path -Recurse -Force -ErrorAction Stop
        $removed++
    } catch {
        $failed++
        Write-Host "    删除失败 $($item.Name): $($_.Exception.Message)" -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "  已删除 $removed 个$(if ($failed -gt 0) { "，失败 $failed 个" })" -ForegroundColor Green
$after = Get-ChildItem -Path $root -Directory -ErrorAction SilentlyContinue
Write-Host "  剩余目录 $($after.Count) 个"
