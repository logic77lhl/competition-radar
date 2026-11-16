# 通知回退方案实测：1) PS5.1 + 已注册的 AppUserModelID 的 toast；2) PS7 的 NotifyIcon 气泡
param([string]$Title = '参赛机会雷达', [string]$Body = '测试通知', [string]$Mode = 'winrt')

if ($Mode -eq 'winrt') {
    $aumid = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
    try {
        [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
        [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]
        $tpl = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
        $nodes = $tpl.GetElementsByTagName('text')
        $nodes.Item(0).AppendChild($tpl.CreateTextNode($Title)) | Out-Null
        $nodes.Item(1).AppendChild($tpl.CreateTextNode($Body)) | Out-Null
        $toast = [Windows.UI.Notifications.ToastNotification]::new($tpl)
        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid).Show($toast)
        Write-Host 'winrt-toast-ok'
    } catch {
        Write-Host ("winrt-toast-fail: {0}" -f $_.Exception.Message)
    }
    exit 0
}

if ($Mode -eq 'balloon') {
    try {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $ni = New-Object System.Windows.Forms.NotifyIcon
        $ni.Icon = [System.Drawing.SystemIcons]::Information
        $ni.BalloonTipTitle = $Title
        $ni.BalloonTipText = $Body
        $ni.Visible = $true
        $ni.ShowBalloonTip(8000)
        Start-Sleep -Seconds 4
        $ni.Dispose()
        Write-Host 'balloon-ok'
    } catch {
        Write-Host ("balloon-fail: {0}" -f $_.Exception.Message)
    }
    exit 0
}
