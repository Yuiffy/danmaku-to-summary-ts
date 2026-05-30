$ErrorActionPreference = 'SilentlyContinue'

$timestamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$outputDir = Join-Path $PSScriptRoot "..\temp\gpu_hang_evidence_$timestamp"
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

Write-Host "输出目录: $outputDir"

"=== time ===" | Out-File (Join-Path $outputDir "summary.txt") -Encoding utf8
Get-Date | Out-File (Join-Path $outputDir "summary.txt") -Append -Encoding utf8

"`n=== nvidia-smi ===" | Out-File (Join-Path $outputDir "summary.txt") -Append -Encoding utf8
nvidia-smi | Out-File (Join-Path $outputDir "summary.txt") -Append -Encoding utf8

"`n=== nvidia compute apps ===" | Out-File (Join-Path $outputDir "summary.txt") -Append -Encoding utf8
nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv | Out-File (Join-Path $outputDir "summary.txt") -Append -Encoding utf8

Get-Process python,node,ffmpeg | Select-Object Id,ProcessName,Path,StartTime |
  Export-Csv -NoTypeInformation -Encoding utf8 (Join-Path $outputDir "processes.csv")

$systemProviders = @('Display', 'nvlddmkm', 'Microsoft-Windows-Kernel-Power', 'Microsoft-Windows-WHEA-Logger', 'Microsoft-Windows-WER-SystemErrorReporting', 'BugCheck')
Get-WinEvent -LogName System -MaxEvents 300 |
  Where-Object { $systemProviders -contains $_.ProviderName } |
  Format-List TimeCreated, ProviderName, Id, LevelDisplayName, Message |
  Out-File (Join-Path $outputDir "system_gpu_related.txt") -Encoding utf8

Get-WinEvent -LogName System -MaxEvents 300 |
  Where-Object { $_.ProviderName -match 'dxgkrnl|Display|nvlddmkm|Kernel-Power|WHEA|BugCheck' } |
  Export-Clixml (Join-Path $outputDir "system_gpu_related.xml")

Write-Host "已完成证据采集。建议同时补充："
Write-Host "1. 可靠性监视器截图"
Write-Host "2. C:\ProgramData\Microsoft\Windows\WER\ReportArchive 和 ReportQueue 中对应时间的报告"
Write-Host "3. C:\Windows\LiveKernelReports\WATCHDOG 与 C:\Windows\Minidump 中的新文件"
