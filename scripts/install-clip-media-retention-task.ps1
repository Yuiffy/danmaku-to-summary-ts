# Run as the current Windows user; no service restart or workflow activation.
[CmdletBinding()]
param([switch]$Disable)
$ErrorActionPreference = 'Stop'
$retentionProjectRoot = Split-Path -Parent $PSScriptRoot
$retentionTaskName = 'Danmaku-Sui-Published-Clip-Retention'
if ($Disable) {
    Disable-ScheduledTask -TaskName $retentionTaskName | Out-Null
    return
}
$retentionPython = (& python -c 'import sys; print(sys.executable)').Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve Python runtime' }
$retentionPythonWindowless = Join-Path (Split-Path -Parent $retentionPython) 'pythonw.exe'
if (-not (Test-Path -LiteralPath $retentionPythonWindowless)) { throw 'pythonw.exe is required for silent hourly maintenance' }
$retentionScript = Join-Path $retentionProjectRoot 'src\scripts\clip_media_retention.py'
$retentionReport = Join-Path $retentionProjectRoot 'data\runtime\clip_media_retention_last_run.json'
$retentionAction = New-ScheduledTaskAction -Execute $retentionPythonWindowless -WorkingDirectory $retentionProjectRoot -Argument ('"{0}" sweep --apply --report "{1}"' -f $retentionScript, $retentionReport)
$retentionTriggers = @(
    (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Hours 1)),
    (New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name))
)
$retentionPrincipal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$retentionSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName $retentionTaskName -Action $retentionAction -Trigger $retentionTriggers -Principal $retentionPrincipal -Settings $retentionSettings -Description 'Remove reproducible Sui derived videos 72 hours after confirmed Bilibili submission; keep replay metadata and final subtitles.' -Force | Select-Object TaskName, State
