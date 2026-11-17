# Explicit operator action: maintain verified merged recording backups.
[CmdletBinding()]
param([switch]$Disable)
$ErrorActionPreference = 'Stop'
$backupProjectRoot = Split-Path -Parent $PSScriptRoot
$backupTaskName = 'Danmaku-Recording-Backup-Retention'
if ($Disable) {
    Disable-ScheduledTask -TaskName $backupTaskName | Out-Null
    return
}
$backupPython = (& python -c 'import sys; print(sys.executable)').Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve Python runtime' }
$backupPythonWindowless = Join-Path (Split-Path -Parent $backupPython) 'pythonw.exe'
if (-not (Test-Path -LiteralPath $backupPythonWindowless)) { throw 'pythonw.exe is required for silent maintenance' }
$backupScript = Join-Path $backupProjectRoot 'src\scripts\recording_backup_retention.py'
$backupReport = Join-Path $backupProjectRoot 'data\runtime\recording_backup_retention_last_run.json'
$backupAction = New-ScheduledTaskAction -Execute $backupPythonWindowless -WorkingDirectory $backupProjectRoot -Argument ('"{0}" --apply --report "{1}"' -f $backupScript, $backupReport)
$backupUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$backupTriggers = @(
    (New-ScheduledTaskTrigger -Once -At (Get-Date).AddHours(1) -RepetitionInterval (New-TimeSpan -Hours 1)),
    (New-ScheduledTaskTrigger -AtLogOn -User $backupUser)
)
$backupPrincipal = New-ScheduledTaskPrincipal -UserId $backupUser -LogonType Interactive -RunLevel Limited
$backupSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2)
Register-ScheduledTask -TaskName $backupTaskName -Action $backupAction -Trigger $backupTriggers -Principal $backupPrincipal -Settings $backupSettings -Description 'Expire bak videos after seven days only with matching merged source map, media identities, duration and reference checks; preserve editorial evidence.' -Force | Select-Object TaskName, State
