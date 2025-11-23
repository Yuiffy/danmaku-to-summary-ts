@echo off
:: 注意：这里删掉了 -InputPaths，直接传 %*
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0auto_summary.ps1" %*
pause
