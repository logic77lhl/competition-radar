<#
    competition-radar 每日运行包装器。
    由 Windows 计划任务调用，也可以手动跑：
        pwsh -NoProfile -File .\run-daily.ps1
        pwsh -NoProfile -File .\run-daily.ps1 -DryRun -NoToast

    它做四件事：
      1. 找到可用的 Node（系统 node，找不到就用 DSH 自带的 Electron 以 node 模式跑）；
      2. 跑 radar.mjs，把 stdout/stderr 落盘到 state\log\；
      3. 弹一个 Windows 通知（尽力而为，失败不影响主流程）；
      4. 把 radar 的退出码原样传出去（计划任务的「上次运行结果」才有意义）。
#>
[CmdletBinding()]
param(
    [string]$Date,
    [switch]$DryRun,
    [switch]$NoToast,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$stateDir = Join-Path $root 'state'
$logDir = Join-Path $stateDir 'log'
$outDir = Join-Path $stateDir 'out'
New-Item -ItemType Directory -Force -Path $logDir, $outDir | Out-Null

$logFile = Join-Path $logDir ("run-{0}.log" -f (Get-Date -Format 'yyyy-MM'))

function Write-Log([string]$msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Add-Content -LiteralPath $logFile -Value $line -Encoding utf8
    if (-not $Quiet) { Write-Host $line }
}

# 尽力而为的 Windows 通知。
# 实测（本机 2026-10）：pwsh 7 的 WinRT toast 拿不到类型；Windows PowerShell 5.1 能加载类型
# 但 CreateToastNotifier 报 0x80073D54（无 package identity）。可用的是 NotifyIcon 气泡，
# 所以把它放第一位；三种都失败就静默跳过 —— 摘要文件才是权威结果。
function Show-RadarToast {
    param([string]$Title, [string]$Body)

    try {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $ni = New-Object System.Windows.Forms.NotifyIcon
        $ni.Icon = [System.Drawing.SystemIcons]::Information
        $ni.BalloonTipTitle = $Title
        $ni.BalloonTipText = $Body
        $ni.Visible = $true
        $ni.ShowBalloonTip(10000)
        Start-Sleep -Seconds 5
        $ni.Dispose()
        return $true
    } catch { }

    try {
        [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
        [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]
        $tpl = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
        $nodes = $tpl.GetElementsByTagName('text')
        $nodes.Item(0).AppendChild($tpl.CreateTextNode($Title)) | Out-Null
        $nodes.Item(1).AppendChild($tpl.CreateTextNode($Body)) | Out-Null
        $toast = [Windows.UI.Notifications.ToastNotification]::new($tpl)
        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('competition-radar').Show($toast)
        return $true
    } catch { }

    try {
        if (Get-Command New-BurntToastNotification -ErrorAction SilentlyContinue) {
            New-BurntToastNotification -Text $Title, $Body
            return $true
        }
    } catch { }

    return $false
}

# ---------------------------------------------------------------- 找 Node ----
function Resolve-NodeRuntime {
    $cmd = Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return @{ Path = $cmd.Source; Electron = $false } }

    # 退路：DSH 桌面版自带的 Electron，用 ELECTRON_RUN_AS_NODE 当 node 使
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe')
    )
    foreach ($c in $candidates) {
        if ($c -and (Test-Path -LiteralPath $c)) { return @{ Path = $c; Electron = $true } }
    }
    return $null
}

$node = Resolve-NodeRuntime
if (-not $node) {
    Write-Log 'FATAL 找不到 Node 运行时（系统 node 与 DSH 自带 Electron 都没有）。'
    exit 3
}

if ($node.Electron) { $env:ELECTRON_RUN_AS_NODE = '1' } else { Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
Write-Log "node = $($node.Path) (electron-as-node=$($node.Electron))"

# ------------------------------------------------------------------ 跑雷达 ----
$radar = Join-Path $root 'radar.mjs'
$radarArgs = @($radar)
if ($Date) { $radarArgs += @('--date', $Date) }
if ($DryRun) { $radarArgs += '--dry-run' }
if ($Quiet) { $radarArgs += '--quiet' }

$output = & $node.Path @radarArgs 2>&1
$code = $LASTEXITCODE
foreach ($l in (($output | Out-String) -split "`r?`n")) {
    if ($l.Trim()) { Add-Content -LiteralPath $logFile -Value "    $l" -Encoding utf8 }
}

if ($code -ne 0) {
    Write-Log "radar 退出码 $code —— 这不是「没有新赛事」，是故障。详见上面的输出。"
    if (-not $NoToast) {
        [void](Show-RadarToast -Title '参赛雷达运行失败' -Body "退出码 $code，请看 state\log 里的日志")
    }
    exit $code
}

# ---------------------------------------------------------------- 通知 ----
$digest = Join-Path $outDir 'latest.md'
$headline = '已更新摘要'
if (Test-Path -LiteralPath $digest) {
    $one = Select-String -LiteralPath $digest -Pattern '^\*\*一句话\*\*：' | Select-Object -First 1
    if ($one) { $headline = ($one.Line -replace '^\*\*一句话\*\*：', '').Trim() }
}
Write-Log "摘要：$headline"

if (-not $NoToast) {
    $ok = Show-RadarToast -Title '参赛机会雷达' -Body $headline
    Write-Log ("通知：{0}" -f ($(if ($ok) { '已弹出' } else { '系统不支持，跳过（摘要文件仍然是权威结果）' })))
}

Write-Log "完成。摘要：$digest"
exit 0
