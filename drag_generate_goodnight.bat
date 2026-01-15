@echo off
REM drag_generate_goodnight.bat
REM 用法: 将 AI_HIGHLIGHT.txt 拖放到本文件上，脚本会在同目录生成晚安回复（_晚安回复.md）
setlocal

















)  exit /b %ERRORLEVEL%  node "%~dp0src\scripts\ai_text_generator.js" "%TARGET%"  echo 处理文件: %TARGET%) else (  exit /b %ERRORLEVEL%  node "%~dp0src\scripts\ai_text_generator.js" --batch "%TARGET%"  echo 正在批量处理目录: %TARGET%if exist "%TARGET%\*" (
nREM 如果传入的是目录，则批量处理该目录内所有 AI_HIGHLIGHT 文件
nset TARGET=%~1)  exit /b 1  pause  echo 请将 AI_HIGHLIGHT.txt 文件拖到此批处理文件上运行。nif "%~1"=="" (