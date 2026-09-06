$ErrorActionPreference = 'Stop'
$releaseRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$releaseName = 'danmaku-webhook'
$runtimePath = Join-Path $releaseRoot 'dist'
$stagePath = Join-Path $releaseRoot 'dist.next-structure'
$testedPath = Join-Path $releaseRoot 'build/service'
$releaseStamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$backupPath = Join-Path $releaseRoot "build/deploy-backups/$releaseStamp"

function Assert-WorkspacePath([string]$candidate) {
    $resolved = [System.IO.Path]::GetFullPath($candidate)
    $prefix = $releaseRoot.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing a deployment path outside the workspace: $resolved"
    }
    return $resolved
}

function Read-Pm2Processes {
    $result = pm2 jlist
    if ($LASTEXITCODE -ne 0) { throw 'PM2 process inspection failed' }
    return $result | ConvertFrom-Json -AsHashtable
}

function Invoke-Pm2([string]$action) {
    pm2 $action $releaseName | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "PM2 $action failed for $releaseName" }
}

function Assert-Idle {
    $serviceStatus = Invoke-RestMethod -Uri 'http://127.0.0.1:12523/status' -TimeoutSec 5
    if (-not $serviceStatus.running -or $serviceStatus.processingFiles -ne 0) {
        throw 'Webhook is not healthy and idle; refusing to switch runtime'
    }
    foreach ($file in @('data/delayed_reply_tasks.json', 'src/scripts/.whisper_queue.json')) {
        $state = Get-Content -LiteralPath (Join-Path $releaseRoot $file) -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
        $active = @($state.tasks | Where-Object {
            if ($_.status -eq 'processing') { return $true }
            if ($_.status -notin @('pending', 'waiting_comic', 'waiting_summary', 'waiting_live_content')) { return $false }
            if ($file -eq 'src/scripts/.whisper_queue.json') { return $true }
            # Persisted future tasks are restored with their deadline after the switch.
            return (-not $_.scheduledTime -or [DateTimeOffset]::Parse($_.scheduledTime) -le [DateTimeOffset]::UtcNow.AddSeconds(30))
        })
        if ($active.Count -gt 0) { throw "Active tasks in $file; refusing to switch runtime" }
    }
}

function Wait-Healthy {
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        try {
            $health = Invoke-RestMethod -Uri 'http://127.0.0.1:12523/health' -TimeoutSec 2
            if ($health.status -eq 'healthy') { return }
        }
        catch { }
        Start-Sleep -Milliseconds 500
    }
    throw 'Webhook did not become healthy after the runtime switch'
}

$runtimePath = Assert-WorkspacePath $runtimePath
$stagePath = Assert-WorkspacePath $stagePath
$backupPath = Assert-WorkspacePath $backupPath
if (-not (Test-Path -LiteralPath (Join-Path $stagePath 'app/main.js'))) { throw 'Staged entrypoint is missing' }
if (Test-Path -LiteralPath $backupPath) { throw 'Backup directory already exists' }

$stageFiles = @(Get-ChildItem -LiteralPath $stagePath -File -Recurse | Where-Object { $_.Extension -in @('.js', '.json') })
$testedFiles = @(Get-ChildItem -LiteralPath $testedPath -File -Recurse | Where-Object { $_.Extension -in @('.js', '.json') })
if ($stageFiles.Count -eq 0 -or $stageFiles.Count -ne $testedFiles.Count) { throw 'Staged and tested runtime inventories differ' }
foreach ($file in $stageFiles) {
    $relative = [System.IO.Path]::GetRelativePath($stagePath, $file.FullName)
    $testedFile = Join-Path $testedPath $relative
    if (-not (Test-Path -LiteralPath $testedFile)) { throw "Untested emitted module: $relative" }
    if ((Get-FileHash -LiteralPath $file.FullName).Hash -ne (Get-FileHash -LiteralPath $testedFile).Hash) {
        throw "Staged module differs from tested output: $relative"
    }
}

$activeWorkflow = Get-Content -LiteralPath (Join-Path $releaseRoot 'data/runtime/workflow-release.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$candidateWorkflow = Get-Content -LiteralPath (Join-Path $releaseRoot 'build/workflow-candidate.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($activeWorkflow.version -ne $candidateWorkflow.version) { throw 'Active workflows do not match the tested candidate' }
foreach ($entry in @('ai_text_generator.js', 'enhanced_auto_summary.js')) {
    node (Join-Path $releaseRoot "src/scripts/$entry") --check-runtime | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Workflow runtime check failed: $entry" }
}

$before = @(Read-Pm2Processes)
$target = @($before | Where-Object { $_.name -eq $releaseName })
if ($target.Count -ne 1 -or $target[0].pm2_env.status -ne 'online') { throw 'Expected one online webhook process' }
if ($target[0].pm2_env.pm_exec_path -ne (Join-Path $runtimePath 'app/main.js')) { throw 'Unexpected PM2 entrypoint' }
Assert-Idle
New-Item -ItemType Directory -Path $backupPath | Out-Null

$stateFiles = [ordered]@{
    delayed_tasks = Join-Path $releaseRoot 'data/delayed_reply_tasks.json'
    summary_queue = Join-Path $releaseRoot 'src/scripts/.whisper_queue.json'
    production_config = Join-Path $releaseRoot 'config/production.json'
    workflow_pointer = Join-Path $releaseRoot 'data/runtime/workflow-release.json'
    reply_history = [System.IO.Path]::GetFullPath((Join-Path $releaseRoot '../data/reply_history.json'))
}
$stateBefore = @{}
foreach ($item in $stateFiles.GetEnumerator()) {
    if (Test-Path -LiteralPath $item.Value) {
        Copy-Item -LiteralPath $item.Value -Destination (Join-Path $backupPath ($item.Key + '.json'))
        $stateBefore[$item.Key] = (Get-FileHash -LiteralPath $item.Value).Hash
    }
}
$before | ForEach-Object {
    [ordered]@{ name = $_.name; id = $_.pm_id; pid = $_.pid; status = $_.pm2_env.status; script = $_.pm2_env.pm_exec_path }
} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $backupPath 'processes-before.json') -Encoding utf8

Assert-Idle
$stopped = $false
$oldMoved = $false
$newMoved = $false
$switchStarted = (Get-Date).ToUniversalTime()
try {
    Invoke-Pm2 'stop'
    $stopped = $true
    Move-Item -LiteralPath $runtimePath -Destination (Join-Path $backupPath 'dist')
    $oldMoved = $true
    Move-Item -LiteralPath $stagePath -Destination $runtimePath
    $newMoved = $true
    Push-Location -LiteralPath $releaseRoot
    try {
        node -e 'new (require("./dist/services/bilibili/ReplyHistoryStore.js").ReplyHistoryStore)().initialize().catch(error => { console.error(error.message); process.exitCode = 1; });'
        if ($LASTEXITCODE -ne 0) { throw 'Reply history migration failed' }
    }
    finally { Pop-Location }
    Invoke-Pm2 'restart'
    $stopped = $false
    Wait-Healthy
    $tasks = Invoke-RestMethod -Uri 'http://127.0.0.1:12523/api/delayed-reply/tasks' -TimeoutSec 5
    if ($null -eq $tasks.tasks) { throw 'New delayed-task endpoint did not return a task list' }
    $savedTasks = Get-Content -LiteralPath (Join-Path $backupPath 'delayed_tasks.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($savedTask in @($savedTasks.tasks | Where-Object { $_.status -in @('pending', 'waiting_comic', 'waiting_summary', 'waiting_live_content') })) {
        $restored = @($tasks.tasks | Where-Object { $_.taskId -eq $savedTask.taskId })
        if ($restored.Count -ne 1 -or $restored[0].status -ne $savedTask.status -or [DateTimeOffset]$restored[0].scheduledTime -ne [DateTimeOffset]$savedTask.scheduledTime) {
            throw 'A future delayed task was not restored with its original deadline'
        }
    }
    $after = @(Read-Pm2Processes)
    $newTarget = @($after | Where-Object { $_.name -eq $releaseName })[0]
    if ($newTarget.pm2_env.status -ne 'online' -or $newTarget.pid -eq $target[0].pid) { throw 'PM2 did not replace the process' }
    $stateAfter = @{}
    foreach ($item in $stateFiles.GetEnumerator()) {
        if (Test-Path -LiteralPath $item.Value) {
            $stateAfter[$item.Key] = (Get-FileHash -LiteralPath $item.Value).Hash
        }
    }
    $legacyHistory = @(Get-Content -LiteralPath $stateFiles.reply_history -Raw -Encoding UTF8 | ConvertFrom-Json)
    $canonicalHistory = @(Get-Content -LiteralPath (Join-Path $releaseRoot 'data/reply_history.json') -Raw -Encoding UTF8 | ConvertFrom-Json)
    foreach ($record in $legacyHistory) {
        $preserved = @($canonicalHistory | Where-Object { $_.dynamicId -eq $record.dynamicId -and (-not $record.success -or $_.success) })
        if ($preserved.Count -eq 0) { throw 'Historical reply identity missing after migration' }
    }
    if ($stateAfter.reply_history -ne $stateBefore.reply_history) { throw 'Legacy history was unexpectedly modified' }
    $report = [ordered]@{
        completedAt = (Get-Date).ToUniversalTime().ToString('o')
        commit = (git rev-parse HEAD)
        backup = $backupPath
        previousPid = $target[0].pid
        currentPid = $newTarget.pid
        port = 12523
        healthy = $true
        switchSeconds = [Math]::Round(((Get-Date).ToUniversalTime() - $switchStarted).TotalSeconds, 2)
        verifiedRuntimeFiles = $stageFiles.Count
        workflowVersion = $activeWorkflow.version
        legacyHistoryCount = $legacyHistory.Count
        canonicalHistoryCount = $canonicalHistory.Count
        historicalDedupePreserved = $true
        taskCount = @($tasks.tasks).Count
        stateBefore = $stateBefore
        stateAfter = $stateAfter
        otherProcesses = @($before | Where-Object { $_.name -ne $releaseName } | ForEach-Object {
            $oldProcess = $_
            $current = @($after | Where-Object { $_.pm_id -eq $oldProcess.pm_id })[0]
            [ordered]@{ name = $oldProcess.name; previousPid = $oldProcess.pid; currentPid = $current.pid; status = $current.pm2_env.status }
        })
    }
    $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $backupPath 'deployment.json') -Encoding utf8
    $report | ConvertTo-Json -Depth 6
}
catch {
    $deploymentError = $_
    if ($newMoved) {
        Invoke-Pm2 'stop'
        $stopped = $true
        Move-Item -LiteralPath $runtimePath -Destination (Join-Path $backupPath 'failed-dist')
    }
    if ($oldMoved) {
        Move-Item -LiteralPath (Join-Path $backupPath 'dist') -Destination $runtimePath
    }
    if ($stopped) {
        Invoke-Pm2 'restart'
        Wait-Healthy
    }
    throw $deploymentError
}
