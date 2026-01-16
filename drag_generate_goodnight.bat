@echo off
REM drag_generate_goodnight.bat
REM 用法: 将 AI_HIGHLIGHT.txt 拖放到本文件上，脚本会在同目录生成晚安回复（_晚安回复.md）
setlocal

REM 检查是否传入了参数
if "%~1"=="" (
    echo 请将 AI_HIGHLIGHT.txt 文件或包含该文件的目录拖到此批处理文件上运行。
    pause
    exit /b 1
)

REM 设置目标路径
set TARGET=%~1

REM 检查目标是文件还是目录
if exist "%TARGET%\*" (
    REM 如果是目录，批量处理
    echo 正在批量处理目录: %TARGET%
    node "%~dp0src\scripts\ai_text_generator.js" --batch "%TARGET%"
    set RC=%ERRORLEVEL%
) else (
    REM 如果是文件，处理单个文件
    echo 处理文件: %TARGET%
    node "%~dp0src\scripts\ai_text_generator.js" "%TARGET%"
    set RC=%ERRORLEVEL%
)

REM 检查退出码
if %RC%==0 (
    echo 处理已完成。
) else (
    echo 处理完成（可能有错误，查看上方日志）。
)

pause
exit /b %RC%