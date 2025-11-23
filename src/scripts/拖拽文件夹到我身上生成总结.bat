@echo off
:: %* 表示将所有拖入的文件作为参数传递给 PowerShell
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0auto_summary.ps1" -InputPaths %*
pause
