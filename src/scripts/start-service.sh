#!/bin/bash
echo "启动弹幕转总结服务..."
cd "$(dirname "$0")"
node dist/app/main.js
