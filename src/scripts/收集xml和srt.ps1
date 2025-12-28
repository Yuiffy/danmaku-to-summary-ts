# Collect XML and SRT files and pack them separately
# Collect from two directories: D:\files\videos\DDTV¼�� and E:\EFiles\Evideo\DDTV¼��-E

$logPath = "d:\files\videos\DDTV¼��\.cursor\debug.log"

function Write-DebugLog {
    param([string]$Location, [string]$Message, [hashtable]$Data, [string]$HypothesisId = "")
    $logEntry = @{
        sessionId = "debug-session"
        runId = "run1"
        hypothesisId = $HypothesisId
        location = $Location
        message = $Message
        data = $Data
        timestamp = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
    } | ConvertTo-Json -Compress -Depth 10
    try {
        Add-Content -Path $logPath -Value $logEntry -Encoding UTF8 -ErrorAction SilentlyContinue
    } catch {}
}

# #region agent log
Write-DebugLog -Location "collect_xml_srt.ps1:7" -Message "Script started" -Data @{timestamp = Get-Date} -HypothesisId "A,B,C"
# #endregion

$root1 = "D:\files\videos\DDTV录播"
$root2 = "E:\EFiles\Evideo\DDTV录播-E"
$outputDir = "D:\files\videos\DDTV录播\脚本"
$zipXml = Join-Path $outputDir "collected_xml_files.zip"
$zipSrt = Join-Path $outputDir "collected_srt_files.zip"
$zipTxt = Join-Path $outputDir "collected_ai_highlight_txt_files.zip"

# #region agent log
Write-DebugLog -Location "collect_xml_srt.ps1:15" -Message "Paths initialized" -Data @{root1 = $root1; root2 = $root2; outputDir = $outputDir; root1Exists = (Test-Path $root1); root2Exists = (Test-Path $root2)} -HypothesisId "B,C"
# #endregion

function Test-Unlocked {
    param([string]$Path)
    # #region agent log
    Write-DebugLog -Location "collect_xml_srt.ps1:Test-Unlocked:entry" -Message "Test-Unlocked called" -Data @{path = $Path} -HypothesisId "D"
    # #endregion
    try {
        $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)
        $fs.Close()
        # #region agent log
        Write-DebugLog -Location "collect_xml_srt.ps1:Test-Unlocked:success" -Message "File unlocked" -Data @{path = $Path; result = $true} -HypothesisId "D"
        # #endregion
        return $true
    }
    catch {
        # #region agent log
        Write-DebugLog -Location "collect_xml_srt.ps1:Test-Unlocked:error" -Message "File locked or error" -Data @{path = $Path; error = $_.Exception.Message; result = $false} -HypothesisId "D"
        # #endregion
        return $false
    }
}

function Collect-Files {
    param([string]$RootPath, [string]$Extension, [string]$Filter = "")
    # #region agent log
    Write-DebugLog -Location "collect_xml_srt.ps1:Collect-Files:entry" -Message "Collect-Files called" -Data @{rootPath = $RootPath; extension = $Extension; filter = $Filter} -HypothesisId "B,C,D"
    # #endregion
    
    if (-not (Test-Path $RootPath)) {
        # #region agent log
        Write-DebugLog -Location "collect_xml_srt.ps1:Collect-Files:pathMissing" -Message "Directory does not exist" -Data @{rootPath = $RootPath} -HypothesisId "C"
        # #endregion
        Write-Warning "Directory does not exist, skipped: $RootPath"
        return @()
    }
    
    try {
        Push-Location -LiteralPath $RootPath
        # #region agent log
        Write-DebugLog -Location "collect_xml_srt.ps1:Collect-Files:afterPush" -Message "Changed directory" -Data @{rootPath = $RootPath; currentPath = (Get-Location).Path} -HypothesisId "B"
        # #endregion
        
        if ($Filter -ne "") {
            $allFiles = Get-ChildItem -Recurse -Filter $Filter -File -ErrorAction SilentlyContinue
        } else {
            $allFiles = Get-ChildItem -Recurse -Filter "*.$Extension" -File -ErrorAction SilentlyContinue
        }
        # #region agent log
        Write-DebugLog -Location "collect_xml_srt.ps1:Collect-Files:afterGetChildItem" -Message "Files found" -Data @{rootPath = $RootPath; extension = $Extension; totalCount = $allFiles.Count} -HypothesisId "D"
        # #endregion
        
        $files = $allFiles | Where-Object { Test-Unlocked $_.FullName } | Select-Object -Expand FullName
        $skipped = $allFiles | Where-Object { -not (Test-Unlocked $_.FullName) } | Select-Object -Expand FullName
        
        # #region agent log
        Write-DebugLog -Location "collect_xml_srt.ps1:Collect-Files:afterFilter" -Message "Files filtered" -Data @{rootPath = $RootPath; extension = $Extension; unlockedCount = $files.Count; lockedCount = $skipped.Count} -HypothesisId "D"
        # #endregion
        
        Pop-Location
        
        if ($skipped) {
            Write-Warning "Skipped locked $Extension files from $RootPath :`n$($skipped -join "`n")"
        }
        
        # #region agent log
        Write-DebugLog -Location "collect_xml_srt.ps1:Collect-Files:exit" -Message "Collect-Files returning" -Data @{rootPath = $RootPath; extension = $Extension; returnCount = $files.Count} -HypothesisId "B,C,D"
        # #endregion
        return $files
    }
    catch {
        # #region agent log
        Write-DebugLog -Location "collect_xml_srt.ps1:Collect-Files:error" -Message "Error in Collect-Files" -Data @{rootPath = $RootPath; extension = $Extension; error = $_.Exception.Message; stackTrace = $_.ScriptStackTrace} -HypothesisId "D,F"
        # #endregion
        Pop-Location -ErrorAction SilentlyContinue
        return @()
    }
}

function Remove-ZipFileSafely {
    param([string]$ZipPath)
    # #region agent log
    Write-DebugLog -Location "collect_xml_srt.ps1:Remove-ZipFileSafely:entry" -Message "Removing ZIP file safely" -Data @{zipPath = $ZipPath} -HypothesisId "E"
    # #endregion
    
    if (-not (Test-Path $ZipPath)) {
        return $true
    }
    
    $maxRetries = 10
    $retryDelay = 500  # milliseconds
    
    for ($i = 0; $i -lt $maxRetries; $i++) {
        try {
            # Try to open the file exclusively to check if it's locked
            $fileStream = [System.IO.File]::Open($ZipPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
            $fileStream.Close()
            $fileStream.Dispose()
            
            # File is not locked, try to delete
            Remove-Item $ZipPath -Force -ErrorAction Stop
            # #region agent log
            Write-DebugLog -Location "collect_xml_srt.ps1:Remove-ZipFileSafely:success" -Message "ZIP file removed successfully" -Data @{zipPath = $ZipPath; attempt = $i + 1} -HypothesisId "E"
            # #endregion
            return $true
        }
        catch {
            if ($i -lt $maxRetries - 1) {
                # #region agent log
                Write-DebugLog -Location "collect_xml_srt.ps1:Remove-ZipFileSafely:retry" -Message "ZIP file locked, retrying" -Data @{zipPath = $ZipPath; attempt = $i + 1; error = $_.Exception.Message} -HypothesisId "E"
                # #endregion
                Start-Sleep -Milliseconds $retryDelay
            } else {
                # #region agent log
                Write-DebugLog -Location "collect_xml_srt.ps1:Remove-ZipFileSafely:failed" -Message "Failed to remove ZIP file after retries" -Data @{zipPath = $ZipPath; attempts = $maxRetries; error = $_.Exception.Message} -HypothesisId "E"
                # #endregion
                Write-Warning "Failed to remove existing ZIP file after $maxRetries attempts: $ZipPath"
                Write-Warning "Please close any programs that might be using this file and try again."
                return $false
            }
        }
    }
    
    return $false
}

function Pack-Files {
    param([array]$FileList, [string]$ZipPath, [string]$FileType)
    # #region agent log
    Write-DebugLog -Location "collect_xml_srt.ps1:Pack-Files:entry" -Message "Pack-Files called" -Data @{fileType = $FileType; fileCount = $FileList.Count; zipPath = $ZipPath} -HypothesisId "E,F"
    # #endregion
    
    if ($FileList.Count -eq 0) {
        # #region agent log
        Write-DebugLog -Location "collect_xml_srt.ps1:Pack-Files:empty" -Message "No files to pack" -Data @{fileType = $FileType} -HypothesisId "E"
        # #endregion
        Write-Warning "No $FileType files to pack (may all be locked or not exist)"
        return
    }
    
    Write-Host "Packing $($FileList.Count) $FileType files to $ZipPath..." -ForegroundColor Green
    
    # Safely remove existing ZIP file if it exists
    if (-not (Remove-ZipFileSafely -ZipPath $ZipPath)) {
        Write-Error "Cannot proceed: existing ZIP file is locked. Please close any programs using it and try again."
        return
    }
    
    $tempDir = Join-Path $env:TEMP "xml_srt_collect_$FileType$(Get-Date -Format 'yyyyMMddHHmmss')"
    # #region agent log
    Write-DebugLog -Location "collect_xml_srt.ps1:Pack-Files:tempDir" -Message "Temp directory created" -Data @{tempDir = $tempDir} -HypothesisId "E"
    # #endregion
    New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
    
    try {
        $processedCount = 0
        $skippedCount = 0
        foreach ($filePath in $FileList) {
            try {
                $normalizedPath = [System.IO.Path]::GetFullPath($filePath)
                $normalizedRoot1 = [System.IO.Path]::GetFullPath($root1)
                $normalizedRoot2 = [System.IO.Path]::GetFullPath($root2)
                
                # #region agent log
                Write-DebugLog -Location "collect_xml_srt.ps1:Pack-Files:normalize" -Message "Path normalized" -Data @{originalPath = $filePath; normalizedPath = $normalizedPath; normalizedRoot1 = $normalizedRoot1; normalizedRoot2 = $normalizedRoot2} -HypothesisId "B"
                # #endregion
                
                $sourceRoot = $null
                
                if ($normalizedPath.StartsWith($normalizedRoot1, [System.StringComparison]::OrdinalIgnoreCase)) {
                    $sourceRoot = $normalizedRoot1
                }
                elseif ($normalizedPath.StartsWith($normalizedRoot2, [System.StringComparison]::OrdinalIgnoreCase)) {
                    $sourceRoot = $normalizedRoot2
                }
                else {
                    $skippedCount++
                    # #region agent log
                    Write-DebugLog -Location "collect_xml_srt.ps1:Pack-Files:skip" -Message "File skipped - not in known root" -Data @{filePath = $filePath; normalizedPath = $normalizedPath} -HypothesisId "B"
                    # #endregion
                    continue
                }
                
                # Get relative path from root
                # Remove the root path from the full path to get relative path
                # Example: D:\files\videos\DDTV¼��\25788785_�꼺SUI\2025_12_22\file.xml
                # Root: D:\files\videos\DDTV¼��
                # Result: 25788785_�꼺SUI\2025_12_22\file.xml
                $relPath = $normalizedPath.Substring($sourceRoot.Length)
                # Remove leading path separators
                while ($relPath.StartsWith('\') -or $relPath.StartsWith('/')) {
                    $relPath = $relPath.Substring(1)
                }
                
                # Use the relative path directly - it already starts with streamer folder
                # This ensures files are organized by streamer folder in the ZIP
                $destRelPath = $relPath
                $destPath = Join-Path $tempDir $destRelPath
                
                $destDir = Split-Path $destPath -Parent
                if (-not (Test-Path $destDir)) {
                    New-Item -ItemType Directory -Path $destDir -Force | Out-Null
                }
                
                Copy-Item -Path $filePath -Destination $destPath -Force -ErrorAction Stop
                $processedCount++
            }
            catch {
                $skippedCount++
                # #region agent log
                Write-DebugLog -Location "collect_xml_srt.ps1:Pack-Files:copyError" -Message "Error copying file" -Data @{filePath = $filePath; error = $_.Exception.Message} -HypothesisId "F"
                # #endregion
            }
        }
        
        # #region agent log
        Write-DebugLog -Location "collect_xml_srt.ps1:Pack-Files:beforeZip" -Message "Before compression" -Data @{processedCount = $processedCount; skippedCount = $skippedCount; tempDir = $tempDir} -HypothesisId "E"
        # #endregion
        
        # Compress the entire temp directory to preserve folder structure
        # This ensures streamer folders are properly organized in the ZIP
        $filesToZip = Get-ChildItem -Path $tempDir -Recurse -File
        # #region agent log
        Write-DebugLog -Location "collect_xml_srt.ps1:Pack-Files:compress" -Message "Starting compression" -Data @{filesToZipCount = $filesToZip.Count; zipPath = $ZipPath; tempDir = $tempDir} -HypothesisId "E"
        # #endregion
        
        if ($filesToZip.Count -gt 0) {
            # Compress the entire directory to preserve folder structure
            # This will create ZIP with structure: streamer_folder\date_folder\files...
            $compressSuccess = $false
            $maxCompressRetries = 5
            $compressRetryDelay = 1000  # milliseconds
            
            for ($retry = 0; $retry -lt $maxCompressRetries; $retry++) {
                try {
                    Compress-Archive -Path "$tempDir\*" -DestinationPath $ZipPath -CompressionLevel Optimal -ErrorAction Stop
                    $compressSuccess = $true
                    # #region agent log
                    Write-DebugLog -Location "collect_xml_srt.ps1:Pack-Files:compressSuccess" -Message "Compression successful" -Data @{zipPath = $ZipPath; attempt = $retry + 1} -HypothesisId "E"
                    # #endregion
                    break
                }
                catch {
                    if ($retry -lt $maxCompressRetries - 1) {
                        # #region agent log
                        Write-DebugLog -Location "collect_xml_srt.ps1:Pack-Files:compressRetry" -Message "Compression failed, retrying" -Data @{zipPath = $ZipPath; attempt = $retry + 1; error = $_.Exception.Message} -HypothesisId "E"
                        # #endregion
                        Start-Sleep -Milliseconds $compressRetryDelay
                        # Try to remove the partially created file
                        if (Test-Path $ZipPath) {
                            Remove-ZipFileSafely -ZipPath $ZipPath | Out-Null
                        }
                    } else {
                        # #region agent log
                        Write-DebugLog -Location "collect_xml_srt.ps1:Pack-Files:compressFailed" -Message "Compression failed after retries" -Data @{zipPath = $ZipPath; attempts = $maxCompressRetries; error = $_.Exception.Message} -HypothesisId "E"
                        # #endregion
                        throw "Failed to create ZIP file after $maxCompressRetries attempts: $($_.Exception.Message)"
                    }
                }
            }
            
            if (-not $compressSuccess) {
                throw "Failed to compress files to $ZipPath"
            }
        } else {
            Write-Warning "No files found in temp directory to compress"
        }
        
        Write-Host "$FileType files packed successfully!" -ForegroundColor Green
    }
    catch {
        # #region agent log
        Write-DebugLog -Location "collect_xml_srt.ps1:Pack-Files:error" -Message "Error in Pack-Files" -Data @{fileType = $FileType; error = $_.Exception.Message; stackTrace = $_.ScriptStackTrace} -HypothesisId "E,F"
        # #endregion
        Write-Error "Error packing $FileType files: $($_.Exception.Message)"
    }
    finally {
        Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

if (-not (Test-Path $outputDir)) {
    # #region agent log
    Write-DebugLog -Location "collect_xml_srt.ps1:createOutputDir" -Message "Creating output directory" -Data @{outputDir = $outputDir} -HypothesisId "C"
    # #endregion
    New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
}

# #region agent log
Write-DebugLog -Location "collect_xml_srt.ps1:beforeCollectXml" -Message "Starting XML collection" -Data @{} -HypothesisId "A,B,C,D"
# #endregion
Write-Host "Starting XML file collection..." -ForegroundColor Cyan
$xmlFiles1 = Collect-Files -RootPath $root1 -Extension "xml"
$xmlFiles2 = Collect-Files -RootPath $root2 -Extension "xml"
$allXmlFiles = $xmlFiles1 + $xmlFiles2
# #region agent log
Write-DebugLog -Location "collect_xml_srt.ps1:afterCollectXml" -Message "XML collection complete" -Data @{xmlFiles1Count = $xmlFiles1.Count; xmlFiles2Count = $xmlFiles2.Count; allXmlFilesCount = $allXmlFiles.Count} -HypothesisId "A,B,C,D"
# #endregion

# #region agent log
Write-DebugLog -Location "collect_xml_srt.ps1:beforeCollectSrt" -Message "Starting SRT collection" -Data @{} -HypothesisId "A,B,C,D"
# #endregion
Write-Host "Starting SRT file collection..." -ForegroundColor Cyan
$srtFiles1 = Collect-Files -RootPath $root1 -Extension "srt"
$srtFiles2 = Collect-Files -RootPath $root2 -Extension "srt"
$allSrtFiles = $srtFiles1 + $srtFiles2
# #region agent log
Write-DebugLog -Location "collect_xml_srt.ps1:afterCollectSrt" -Message "SRT collection complete" -Data @{srtFiles1Count = $srtFiles1.Count; srtFiles2Count = $srtFiles2.Count; allSrtFilesCount = $allSrtFiles.Count} -HypothesisId "A,B,C,D"
# #endregion

# #region agent log
Write-DebugLog -Location "collect_xml_srt.ps1:beforePackXml" -Message "Starting XML packing" -Data @{} -HypothesisId "E,F"
# #endregion
Pack-Files -FileList $allXmlFiles -ZipPath $zipXml -FileType "XML"
# #region agent log
Write-DebugLog -Location "collect_xml_srt.ps1:beforePackSrt" -Message "Starting SRT packing" -Data @{} -HypothesisId "E,F"
# #endregion
Pack-Files -FileList $allSrtFiles -ZipPath $zipSrt -FileType "SRT"

# #region agent log
Write-DebugLog -Location "collect_xml_srt.ps1:beforeCollectTxt" -Message "Starting TXT collection" -Data @{} -HypothesisId "A,B,C,D"
# #endregion
Write-Host "Starting AI_HIGHLIGHT TXT file collection..." -ForegroundColor Cyan
$txtFiles1 = Collect-Files -RootPath $root1 -Extension "txt" -Filter "*_AI_HIGHLIGHT.txt"
$txtFiles2 = Collect-Files -RootPath $root2 -Extension "txt" -Filter "*_AI_HIGHLIGHT.txt"
$allTxtFiles = $txtFiles1 + $txtFiles2
# #region agent log
Write-DebugLog -Location "collect_xml_srt.ps1:afterCollectTxt" -Message "TXT collection complete" -Data @{txtFiles1Count = $txtFiles1.Count; txtFiles2Count = $txtFiles2.Count; allTxtFilesCount = $allTxtFiles.Count} -HypothesisId "A,B,C,D"
# #endregion

# #region agent log
Write-DebugLog -Location "collect_xml_srt.ps1:beforePackTxt" -Message "Starting TXT packing" -Data @{} -HypothesisId "E,F"
# #endregion
Pack-Files -FileList $allTxtFiles -ZipPath $zipTxt -FileType "AI_HIGHLIGHT_TXT"

# #region agent log
Write-DebugLog -Location "collect_xml_srt.ps1:end" -Message "Script completed" -Data @{xmlZipExists = (Test-Path $zipXml); srtZipExists = (Test-Path $zipSrt); txtZipExists = (Test-Path $zipTxt)} -HypothesisId "A,B,C,D,E,F"
# #endregion
Write-Host "`nCollection completed!" -ForegroundColor Cyan
Write-Host "XML files package: $zipXml" -ForegroundColor Yellow
Write-Host "SRT files package: $zipSrt" -ForegroundColor Yellow
Write-Host "AI_HIGHLIGHT TXT files package: $zipTxt" -ForegroundColor Yellow
