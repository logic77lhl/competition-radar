<#
    注销「参赛机会雷达」的每日计划任务（不会删除任何采集数据）。
    用法：pwsh -NoProfile -File .\unregister-task.ps1
#>
[CmdletBinding()]
param([string]$TaskName = 'DSH-Competition-Radar')

$ErrorActionPreference = 'Stop'
$t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $t) {
    Write-Host "没有找到计划任务 $TaskName（可能已经注销）。"
    exit 0
}
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "已注销计划任务：$TaskName"
Write-Host "采集数据仍在 competition-radar\state\ 下，未受影响。"
