param(
    [ValidateSet('Watch', 'Snapshot', 'Launch', 'SyncCookie')][string]$Mode = 'Snapshot',
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

function Start-RecorderFromSpec($Spec) {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Spec.executablePath
    $start.WorkingDirectory = $Spec.workingDirectory
    $start.UseShellExecute = $true
    $start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    foreach ($argument in @($Spec.arguments)) { [void]$start.ArgumentList.Add([string]$argument) }
    $launched = [Diagnostics.Process]::Start($start)
    try { return $launched.Id } finally { $launched.Dispose() }
}

if ($Mode -eq 'SyncCookie') {
    $temporary = $null
    $syncMutex = $null
    $syncAcquired = $false
    $stopped = $false
    $launched = $false
    $syncStage = 'read_config'
    try {
        $spec = [Console]::In.ReadToEnd() | ConvertFrom-Json
        foreach ($property in @('executablePath', 'workingDirectory', 'sourcePath', 'recorderConfigPath')) {
            if (-not [IO.Path]::IsPathFullyQualified([string]$spec.$property)) { throw 'Expected absolute synchronization paths' }
        }
        $executable = (Resolve-Path -LiteralPath $spec.executablePath).Path
        $target = (Resolve-Path -LiteralPath $spec.recorderConfigPath).Path
        $source = (Resolve-Path -LiteralPath $spec.sourcePath).Path
        if ($source -eq $target -or [IO.Path]::GetExtension($executable) -ne '.exe') { throw 'Invalid synchronization targets' }
        $name = [IO.Path]::GetFileNameWithoutExtension($executable)
        $syncMutex = [Threading.Mutex]::new($false, "Local\DanmakuRecorderWatchdog-$name")
        try { $syncAcquired = $syncMutex.WaitOne(5000) } catch [Threading.AbandonedMutexException] { $syncAcquired = $true }
        if (-not $syncAcquired) { throw 'Another recorder operation is in progress' }
        if ((Get-FileHash -LiteralPath $source).Hash -ne $spec.sourceHash -or (Get-FileHash -LiteralPath $target).Hash -ne $spec.configHash) { throw 'Credential files changed during preparation' }
        $sourceConfig = Get-Content -LiteralPath $source -Raw -Encoding utf8 | ConvertFrom-Json
        $recorderConfig = Get-Content -LiteralPath $target -Raw -Encoding utf8 | ConvertFrom-Json
        $newCookie = [string]$sourceConfig.bilibili.cookie
        $oldCookie = [string]$recorderConfig.global.Cookie.Value
        $newUid = [regex]::Match($newCookie, '(?:^|;)\s*DedeUserID=([^;]+)').Groups[1].Value
        $oldUid = [regex]::Match($oldCookie, '(?:^|;)\s*DedeUserID=([^;]+)').Groups[1].Value
        if (-not $newUid -or $newUid -ne $oldUid) { throw 'Cookie account mismatch' }
        foreach ($key in @('SESSDATA', 'bili_jct', 'buvid3')) {
            if (-not [regex]::IsMatch($newCookie, ('(?:^|;)\s*' + $key + '=([^;]+)'))) { throw 'Incomplete source cookie' }
        }
        if ($newCookie -eq $oldCookie) {
            Write-Result @{ changed = $false; reason = 'already_current' }
        } else {
            $syncStage = 'validate_process'
            # ConvertFrom-Json may parse ISO timestamps as DateTime. Normalize
            # explicitly so a locale-dependent string conversion cannot reject
            # the same process start time returned by the observer.
            $expectedStart = ([datetime]$spec.expectedStartedAt).ToUniversalTime().ToString('o')
            $existing = @(Get-RecorderProcesses $name)
            if ($existing.Count -ne 1 -or $existing[0].pid -ne $spec.expectedPid -or $existing[0].startedAt -ne $expectedStart -or $existing[0].executablePath -ne $executable) { throw 'Recorder process identity changed' }
            $recorderConfig.global.Cookie.Value = $newCookie
            # Prepare the entire file before stopping. The candidate and backup
            # stay beside the explicitly configured target for atomic replacement.
            $temporary = $target + '.cookie-next-' + [guid]::NewGuid().ToString('N')
            [IO.File]::WriteAllText($temporary, (($recorderConfig | ConvertTo-Json -Depth 100) + "`n"), [Text.UTF8Encoding]::new($false))
            if ((Get-FileHash -LiteralPath $source).Hash -ne $spec.sourceHash -or (Get-FileHash -LiteralPath $target).Hash -ne $spec.configHash) { throw 'Credential files changed before restart' }
            $syncStage = 'stop_process'
            $running = Get-Process -Id $spec.expectedPid -ErrorAction Stop
            try {
                if ($running.Path -ne $executable -or $running.StartTime.ToUniversalTime().ToString('o') -ne $expectedStart) { throw 'Recorder process identity changed before restart' }
                Stop-Process -Id $running.Id -ErrorAction Stop
                $stopped = $true
                if (-not $running.WaitForExit(10000)) { throw 'Recorder did not stop' }
            } finally { $running.Dispose() }
            if ((Get-FileHash -LiteralPath $target).Hash -ne $spec.configHash) { throw 'Recorder config changed during restart' }
            $syncStage = 'replace_config'
            [IO.File]::Replace($temporary, $target, ($target + '.before-cookie-sync'))
            $syncStage = 'launch_process'
            $newPid = Start-RecorderFromSpec $spec
            $launched = $true
            Write-Result @{ changed = $true; pid = $newPid }
        }
    } catch {
        # Parsing exceptions can quote secrets from a JSON document. Never emit
        # the original exception or credential contents from this helper.
        [Console]::Error.WriteLine("Recorder credential synchronization failed at $syncStage; inspect file paths and process identity.")
        exit 1
    } finally {
        if ($stopped -and -not $launched) {
            # Keep a successfully installed new credential: the previous session
            # may already be revoked. The regular watchdog can retry a launch.
            try { if (@(Get-RecorderProcesses $name).Count -eq 0) { [void](Start-RecorderFromSpec $spec) } } catch { }
        }
        if ($temporary -and (Test-Path -LiteralPath $temporary)) { Remove-Item -LiteralPath $temporary -Force }
        if ($syncAcquired) { $syncMutex.ReleaseMutex() }
        if ($null -ne $syncMutex) { $syncMutex.Dispose() }
    }
    exit 0
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
