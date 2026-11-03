[CmdletBinding()]
param([switch]$Disable)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$taskName = 'Danmaku-Project-Temp-Retention'
if ($Disable) {
    Disable-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Out-Null
    return
}
$python = (& python -c 'import sys; print(sys.executable)').Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve Python runtime' }
$pythonw = Join-Path (Split-Path -Parent $python) 'pythonw.exe'
if (-not (Test-Path -LiteralPath $pythonw)) { throw 'pythonw.exe is required for silent maintenance' }
$script = Join-Path $projectRoot 'src\scripts\project_temp_retention.py'
$report = Join-Path $projectRoot 'data\runtime\project_temp_retention_last_run.json'
$action = New-ScheduledTaskAction -Execute $pythonw -WorkingDirectory $projectRoot -Argument ('"{0}" --apply --report "{1}"' -f $script, $report)
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$triggers = @(
    (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Hours 1)),
    (New-ScheduledTaskTrigger -AtLogOn -User $user)
)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Description 'Expire disposable project temp evidence after seven days; preserve links, marked directories and current tasks.' -Force | Select-Object TaskName, State
