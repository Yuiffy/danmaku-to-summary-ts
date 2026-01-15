@echo off
echo 启动弹幕转总结服务...
cd /d "%~dp0"
node dist/app/main.js
pause
