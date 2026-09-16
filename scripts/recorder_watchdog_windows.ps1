param(
    [ValidateSet('Watch', 'Snapshot', 'Launch')][string]$Mode = 'Snapshot',
    [string]$ProcessName = 'BililiveRecorder.WPF',
    [ValidateRange(1000, 60000)][int]$IntervalMs = 5000
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)

function Get-RecorderProcesses([string]$Name) {
    $items = @()
    foreach ($process in [Diagnostics.Process]::GetProcessesByName($Name)) {
        try {
            $executable = $null
            try { $executable = $process.MainModule.FileName } catch { }
            $items += [ordered]@{
                pid = $process.Id
                executablePath = $executable
                sessionId = $process.SessionId
                startedAt = $process.StartTime.ToUniversalTime().ToString('o')
            }
        } finally {
            $process.Dispose()
        }
    }
    return $items
}

function Write-Result($Value) {
    [Console]::WriteLine(($Value | ConvertTo-Json -Depth 5 -Compress))
}

if ($Mode -eq 'Launch') {
    $spec = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $executable = (Resolve-Path -LiteralPath $spec.executablePath).Path
    $workingDirectory = (Resolve-Path -LiteralPath $spec.workingDirectory).Path
    if ([IO.Path]::GetExtension($executable) -ne '.exe') { throw 'Expected a Windows executable' }
    $name = [IO.Path]::GetFileNameWithoutExtension($executable)
    $mutex = [Threading.Mutex]::new($false, "Local\DanmakuRecorderWatchdog-$name")
    $acquired = $false
    try {
        try { $acquired = $mutex.WaitOne(5000) } catch [Threading.AbandonedMutexException] { $acquired = $true }
        if (-not $acquired) { throw 'Another recorder launch is in progress' }
        $existing = @(Get-RecorderProcesses $name)
        if ($existing.Count -gt 0) {
            Write-Result @{ started = $false; reason = 'already_running'; processes = $existing }
            exit 0
        }
        $start = [Diagnostics.ProcessStartInfo]::new()
        $start.FileName = $executable
        $start.WorkingDirectory = $workingDirectory
        $start.UseShellExecute = $true
        $start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
        foreach ($argument in @($spec.arguments)) { [void]$start.ArgumentList.Add([string]$argument) }
        $process = [Diagnostics.Process]::Start($start)
        try { Write-Result @{ started = $true; pid = $process.Id } } finally { $process.Dispose() }
    } finally {
        if ($acquired) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
    exit 0
}

do {
    try {
        Write-Result @{ processes = @(Get-RecorderProcesses $ProcessName) }
    } catch {
        Write-Result @{ error = $_.Exception.Message }
    }
    if ($Mode -eq 'Watch') { Start-Sleep -Milliseconds $IntervalMs }
} while ($Mode -eq 'Watch')
