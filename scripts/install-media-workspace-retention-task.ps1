# Explicit operator action: install hourly cleanup of completed, declared media caches.
[CmdletBinding()]
param([switch]$Disable)
$ErrorActionPreference = 'Stop'
$workspaceProjectRoot = Split-Path -Parent $PSScriptRoot
$workspaceTaskName = 'Danmaku-Media-Workspace-Retention'
if ($Disable) {
    Disable-ScheduledTask -TaskName $workspaceTaskName | Out-Null
    return
}
$workspacePython = (& python -c 'import sys; print(sys.executable)').Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve Python runtime' }
$workspacePythonWindowless = Join-Path (Split-Path -Parent $workspacePython) 'pythonw.exe'
if (-not (Test-Path -LiteralPath $workspacePythonWindowless)) { throw 'pythonw.exe is required for silent maintenance' }
$workspaceScript = Join-Path $workspaceProjectRoot 'src\scripts\media_workspace_retention.py'
$workspaceReport = Join-Path $workspaceProjectRoot 'data\runtime\media_workspace_retention_last_run.json'
$workspaceAction = New-ScheduledTaskAction -Execute $workspacePythonWindowless -WorkingDirectory $workspaceProjectRoot -Argument ('"{0}" sweep --apply --report "{1}"' -f $workspaceScript, $workspaceReport)
$workspaceUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$workspaceTriggers = @(
    (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Hours 1)),
    (New-ScheduledTaskTrigger -AtLogOn -User $workspaceUser)
)
$workspacePrincipal = New-ScheduledTaskPrincipal -UserId $workspaceUser -LogonType Interactive -RunLevel Limited
$workspaceSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName $workspaceTaskName -Action $workspaceAction -Trigger $workspaceTriggers -Principal $workspacePrincipal -Settings $workspaceSettings -Description 'Expire declared disposable media caches seven days after workspace completion; preserve original recordings, final media and editorial evidence.' -Force | Select-Object TaskName, State
