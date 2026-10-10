# Install a logon task for only the two local workspace processes.
[CmdletBinding()]
param([switch]$Disable)
$ErrorActionPreference = 'Stop'
$adminTaskName = 'Danmaku-Web-Admin'
if ($Disable) {
    Disable-ScheduledTask -TaskName $adminTaskName | Out-Null
    return
}
$adminProjectRoot = Split-Path -Parent $PSScriptRoot
$adminPm2Script = (Get-Command pm2 -CommandType ExternalScript -ErrorAction Stop).Source
$adminShell = (Get-Process -Id $PID).Path
$adminConfig = Join-Path $adminProjectRoot 'scripts/ecosystem.admin.config.js'
foreach ($adminArtifact in @('data/runtime/admin/service/tools/admin/server.js', '.next/BUILD_ID')) {
    if (-not (Test-Path -LiteralPath (Join-Path $adminProjectRoot $adminArtifact))) {
        throw "Missing workspace build: $adminArtifact. See docs/web-admin.md."
    }
}
$adminArguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File "{0}" start "{1}"' -f $adminPm2Script, $adminConfig
$adminAction = New-ScheduledTaskAction -Execute $adminShell -WorkingDirectory $adminProjectRoot -Argument $adminArguments
$adminUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$adminTrigger = New-ScheduledTaskTrigger -AtLogOn -User $adminUser
$adminPrincipal = New-ScheduledTaskPrincipal -UserId $adminUser -LogonType Interactive -RunLevel Limited
$adminSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName $adminTaskName -Action $adminAction -Trigger $adminTrigger -Principal $adminPrincipal -Settings $adminSettings -Description 'Start the loopback web administration workspace after login; no workflow activation or production worker restarts.' -Force | Select-Object TaskName, State
