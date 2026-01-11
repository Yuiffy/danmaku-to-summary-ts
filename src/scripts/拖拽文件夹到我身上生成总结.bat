@echo off
:: 注意：这里删掉了 -InputPaths，直接传 %*
node "%~dp0auto_summary.js" %*
pause
