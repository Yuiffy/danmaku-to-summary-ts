# ===================================================
#   DDTV 自动切片流水线 (v5080 Pro)
#   把视频+XML拖进来，自动转字幕 + 自动浓缩摘要
# ===================================================

param (
    [Parameter(ValueFromRemainingArguments=$true)]
    [string[]]$InputPaths
)

# 1. 动态获取当前脚本所在目录
$ScriptRoot = $PSScriptRoot
$PyRoot = Join-Path $ScriptRoot "..\..\..\..\fun\whisper-my-project"

# 2. 默认 Python 脚本就在旁边 (batch_whisper.py)
$PythonScript = Join-Path $PyRoot "batch_whisper.py"
# 如果你执意要用原来的名字，改这里：
# $PythonScript = Join-Path $ScriptRoot "fast_sub_batch_fix.py"

# 3. 默认 Node.js 脚本也在旁边 (highlight_cleaner.js)
$NodeScript = Join-Path $ScriptRoot "do_fusion_summary.js"

# Force UTF-8 output
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Clear-Host
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "      Live Summary 自动化工厂 (Watchdog 启用)       " -ForegroundColor Yellow
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

$VideoExts = @('.mp4', '.flv', '.mkv', '.ts', '.mov', '.m4a')

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
        Write-Host "Please place 'batch_whisper.py' in the same folder as this script." -ForegroundColor Yellow
        Read-Host "Press Enter to exit..."
        exit
    }

    if (-not (Test-Path $SrtPath)) {
        Write-Host "`n-> [ASR] Generating Subtitles (Whisper)..." -ForegroundColor Cyan
        Write-Host "   Target: $(Split-Path $VideoPath -Leaf)" -ForegroundColor Gray
        try {
            # [Fix] 强制 Python 使用 UTF-8 编码，解决 Emoji 打印报错问题
            $env:PYTHONUTF8 = "1"
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

# 检查是否在非交互模式下运行（通过环境变量判断）
if ($env:NODE_ENV -eq 'automation' -or $env:CI) {
    # 非交互模式，直接退出
    exit 0
} else {
    # 交互模式，等待用户输入
    try {
        Read-Host "Press Enter to close..."
    } catch {
        # 如果无法读取输入（非交互模式），直接退出
        exit 0
    }
}
