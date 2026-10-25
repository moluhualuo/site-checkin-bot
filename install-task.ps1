# 每天 08:10 自动签到
# 用法：右键「使用 PowerShell 运行」，或在 PowerShell 里执行 .\install-task.ps1

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$taskName = 'AutoCheckin'

$action = New-ScheduledTaskAction -Execute (Join-Path $root 'run.bat') -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Daily -At 08:10
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopIfGoingOnBatteries `
    -AllowStartIfOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
    -Description '多站点自动签到（需保持用户登录状态，浏览器为有头离屏模式）' -Force | Out-Null

Write-Host "已注册计划任务：$taskName（每天 08:10 运行）" -ForegroundColor Green
Write-Host "查看：Get-ScheduledTask -TaskName $taskName"
Write-Host "删除：Unregister-ScheduledTask -TaskName $taskName -Confirm:`$false"
Write-Host ""
Write-Host "注意：任务以「当前用户 + 交互式会话」运行。电脑关机或未登录时不会执行。" -ForegroundColor Yellow
