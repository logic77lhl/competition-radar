<#
    注册 / 更新「参赛机会雷达」的每日计划任务。

    用法：
        pwsh -NoProfile -File .\register-task.ps1                 # 默认每天 09:00
        pwsh -NoProfile -File .\register-task.ps1 -Time 08:30
        pwsh -NoProfile -File .\register-task.ps1 -RunNow         # 注册完立刻跑一次验证

    两条实现路径（自动选）：
      A. ScheduledTasks 模块（New-ScheduledTask*）—— 需要 CIM/WMI 可用；
      B. schtasks.exe —— 不依赖 CIM，在 WMI 被禁用/被沙箱挡住的机器上是唯一可行的路。

    注意：默认注册为「仅在用户登录时运行」。要改成「无论是否登录都运行」需要账户密码，
    这里刻意不代你保存密码。
#>
[CmdletBinding()]
param(
    [string]$Time = '09:00',
    [string]$TaskName = 'DSH-Competition-Radar',
    [string]$Description = '每日采集在办 AI / AI4S 竞赛，与昨日快照做 diff，产出摘要并通知。',
    [switch]$RunNow
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$runner = Join-Path $root 'run-daily.ps1'
if (-not (Test-Path -LiteralPath $runner)) { throw "找不到 $runner" }

# 选一个 PowerShell 宿主：优先 pwsh 7，退到 Windows PowerShell 5.1
$hostExe = (Get-Command pwsh -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $hostExe) { $hostExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe' }
if (-not (Test-Path -LiteralPath $hostExe)) { throw '找不到可用的 PowerShell 宿主。' }

try { [void][datetime]::ParseExact($Time, 'HH:mm', $null) }
catch { throw "时间格式应为 HH:mm，收到的是 '$Time'" }

$hostArgs = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}"' -f $runner

function Test-CimAvailable {
    try { [void](Get-CimInstance Win32_OperatingSystem -ErrorAction Stop); return $true }
    catch { return $false }
}

$usedCim = $false
if (Test-CimAvailable) {
    try {
        $action = New-ScheduledTaskAction -Execute $hostExe -Argument $hostArgs -WorkingDirectory $root
        $trigger = New-ScheduledTaskTrigger -Daily -At ([datetime]::ParseExact($Time, 'HH:mm', $null))
        $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
            -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
        $principal = New-ScheduledTaskPrincipal -UserId ("{0}\{1}" -f $env:USERDOMAIN, $env:USERNAME) -LogonType Interactive -RunLevel Limited
        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
            -Principal $principal -Description $Description -Force | Out-Null
        $usedCim = $true
    } catch {
        Write-Warning ("ScheduledTasks 模块路径失败（{0}），改用 schtasks.exe。" -f $_.Exception.Message)
    }
}

if (-not $usedCim) {
    # schtasks 的 /TR 里引号要转义；整条命令用双引号包住会踩坑，所以拼成单条字符串
    $tr = '"{0}" {1}' -f $hostExe, $hostArgs
    $out = & schtasks.exe /Create /TN $TaskName /TR $tr /SC DAILY /ST $Time /F 2>&1
    $code = $LASTEXITCODE
    if ($code -ne 0) {
        Write-Host ($out | Out-String)
        throw "schtasks /Create 失败，退出码 $code。"
    }
    Write-Host ($out | Out-String).Trim()
}

Write-Host ''
Write-Host "已注册计划任务：$TaskName  (实现路径：$(if ($usedCim) { 'ScheduledTasks 模块' } else { 'schtasks.exe' }))"
Write-Host ("  宿主 : {0}" -f $hostExe)
Write-Host ("  脚本 : {0}" -f $runner)
Write-Host ("  触发 : 每天 {0}" -f $Time)

if ($usedCim) {
    $t = Get-ScheduledTask -TaskName $TaskName
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    Write-Host ("  状态 : {0}，下次 {1}" -f $t.State, $info.NextRunTime)
} else {
    Write-Host ''
    schtasks.exe /Query /TN $TaskName /FO LIST 2>&1 | Select-Object -First 8
}

if ($RunNow) {
    Write-Host ''
    Write-Host '立刻触发一次以验证…'
    if ($usedCim) {
        Start-ScheduledTask -TaskName $TaskName
        $deadline = (Get-Date).AddMinutes(6)
        do { Start-Sleep -Seconds 5; $info = Get-ScheduledTaskInfo -TaskName $TaskName }
        while ($info.LastTaskResult -eq 267009 -and (Get-Date) -lt $deadline)
        Write-Host ("  上次运行: {0}" -f $info.LastRunTime)
        Write-Host ("  上次结果: {0}  ({1})" -f $info.LastTaskResult, $(if ($info.LastTaskResult -eq 0) { '成功' } else { '失败 —— 去看 state\log' }))
    } else {
        & schtasks.exe /Run /TN $TaskName 2>&1 | Out-String | Write-Host
        Write-Host '等待 45 秒后查状态…'
        Start-Sleep -Seconds 45
        schtasks.exe /Query /TN $TaskName /FO LIST /V 2>&1 | Select-String -Pattern 'Last Run Time|Last Result|上次运行时间|上次结果|Status|状态'
    }
    Write-Host ''
    Write-Host '验证要点：state\out\latest.md 的修改时间应刚刚更新，且 state\log\run-*.log 末尾有「完成」。'
}
