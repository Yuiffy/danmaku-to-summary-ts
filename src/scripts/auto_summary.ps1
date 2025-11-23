# ===================================================
#   Auto Live Summary Pipeline (English Version)
#   Usage: Drag video (.mp4) + danmaku (.xml) onto the .bat file
# ===================================================

param (
    [string[]]$InputPaths
)

# --- Path Configuration ---
# $PSScriptRoot is "D:\workspace\myrepo\danmaku-to-summary-ts\src\scripts"
$ScriptRoot = $PSScriptRoot

# 1. Calculate path to Python script (Assuming it is in the project root, 2 levels up)
# Adjust "..\.." if your python file is somewhere else
$PythonScript = Join-Path $ScriptRoot "..\..\fast_sub_batch_fix.py"

# 2. Calculate path to Node.js script (Assuming it is in the same folder as this ps1)
$NodeScript = Join-Path $ScriptRoot "do_fusion_summary.js"

# Force UTF-8 output
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Clear-Host
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "      Live Summary Pipeline Starting...     " -ForegroundColor Yellow
Write-Host "============================================" -ForegroundColor Cyan

if ($InputPaths.Count -eq 0) {
    Write-Host "X Error: No files detected! Please drag files onto the icon." -ForegroundColor Red
    Read-Host "Press Enter to exit..."
    exit
}

# 1. Classify Files
$VideoFiles = @()
$XmlFiles = @()
$FilesToProcess = @()

$VideoExts = @('.mp4', '.flv', '.mkv', '.ts', '.mov')

Write-Host "-> Analyzing input files..." -ForegroundColor Gray

foreach ($Path in $InputPaths) {
    if (Test-Path $Path -PathType Leaf) {
        $Ext = [System.IO.Path]::GetExtension($Path).ToLower()

        if ($VideoExts -Contains $Ext) {
            Write-Host "   [Video] Found: $(Split-Path $Path -Leaf)" -ForegroundColor DarkGray
            $VideoFiles += $Path
        } elseif ($Ext -eq '.xml') {
            Write-Host "   [XML]   Found: $(Split-Path $Path -Leaf)" -ForegroundColor DarkGray
            $XmlFiles += $Path
            $FilesToProcess += $Path
        } elseif ($Ext -eq '.srt') {
            Write-Host "   [SRT]   Found: $(Split-Path $Path -Leaf)" -ForegroundColor DarkGray
            $FilesToProcess += $Path
        }
    }
}

# 2. Process Video (ASR)
foreach ($VideoPath in $VideoFiles) {
    $Dir = Split-Path $VideoPath -Parent
    $NameNoExt = [System.IO.Path]::GetFileNameWithoutExtension($VideoPath)
    $SrtPath = Join-Path $Dir "$NameNoExt.srt"

    # Check python script existence
    if (-not (Test-Path $PythonScript)) {
        Write-Host "X Error: Python script not found at: $PythonScript" -ForegroundColor Red
        Write-Host "Please check the path configuration in the ps1 file." -ForegroundColor Yellow
        continue
    }

    if (-not (Test-Path $SrtPath)) {
        Write-Host "`n-> [ASR] Generating Subtitles (Whisper)..." -ForegroundColor Cyan
        Write-Host "   Target: $(Split-Path $VideoPath -Leaf)" -ForegroundColor Gray
        try {
            python $PythonScript "$VideoPath"
        } catch {
            Write-Host "X Python Error: $_" -ForegroundColor Red
        }
    } else {
        Write-Host "-> [Skip] Subtitle exists: $(Split-Path $SrtPath -Leaf)" -ForegroundColor Green
    }

    if (Test-Path $SrtPath) {
        $FilesToProcess += $SrtPath
    }
}

Write-Host "`n--------------------------------------------" -ForegroundColor DarkGray

# 3. Node.js Fusion
if ($FilesToProcess.Count -eq 0) {
    Write-Host "X Warning: No valid SRT or XML files to process." -ForegroundColor Yellow
} else {
    Write-Host "-> [Fusion] Merging Subtitles and Danmaku..." -ForegroundColor Magenta

    # Check node script existence
    if (-not (Test-Path $NodeScript)) {
        Write-Host "X Error: Node.js script not found at: $NodeScript" -ForegroundColor Red
    } else {
        try {
            node $NodeScript $FilesToProcess
        } catch {
            Write-Host "X Node.js Error: $_" -ForegroundColor Red
        }
    }
}

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "       All Tasks Completed!                 " -ForegroundColor Green
if ($FilesToProcess.Count -gt 0) {
    $OutDir = Split-Path $FilesToProcess[0] -Parent
    Write-Host "Output Dir: $OutDir" -ForegroundColor Yellow
}
Write-Host "============================================" -ForegroundColor Cyan

# 这一行就是之前报错的地方，现在改成英文了
Read-Host "Press Enter to close..."
