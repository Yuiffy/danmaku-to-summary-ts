#!/usr/bin/env node

const http = require('http');
const path = require('path');
const fs = require('fs');
const configLoader = require('./config-loader');

const testPort = 15121;
const testEndpoints = [
  { path: '/ddtv', name: 'DDTV Webhook' },
  { path: '/mikufans', name: 'mikufans Webhook' }
];

console.log('🔍 测试增强版Webhook服务器...\n');

// 测试服务器是否在运行
function testServerRunning() {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: 'localhost',
      port: testPort,
      path: '/',
      method: 'GET',
      timeout: 2000
    }, (res) => {
      console.log(`✅ 服务器正在运行 (状态码: ${res.statusCode})`);
      resolve(true);
    });
    
    req.on('error', (err) => {
      console.log(`❌ 服务器未运行: ${err.message}`);
      resolve(false);
    });
    
    req.on('timeout', () => {
      console.log('⏰ 连接超时 - 服务器可能未启动');
      req.destroy();
      resolve(false);
    });
    
    req.end();
  });
}

// 测试端点是否响应
async function testEndpointsResponse() {
  for (const endpoint of testEndpoints) {
    console.log(`\n测试 ${endpoint.name} (${endpoint.path})...`);
    
    const testData = endpoint.path === '/ddtv' 
      ? getDDTVTestPayload()
      : getMikufansTestPayload();
    
    try {
      const response = await sendTestRequest(endpoint.path, testData);
      console.log(`✅ ${endpoint.name} 响应正常: ${response.substring(0, 50)}...`);
    } catch (error) {
      console.log(`❌ ${endpoint.name} 测试失败: ${error.message}`);
    }
  }
}

function getDDTVTestPayload() {
  return {
    cmd: "SaveBulletScreenFile",
    code: 40101,
    data: {
      Name: "测试主播",
      DownInfo: {
        DownloadFileList: {
          DanmuFile: ["D:/test/path/test.xml"],
          CurrentOperationVideoFile: "D:/test/path/test_original.mp4"
        }
      }
    },
    message: "测试保存弹幕文件"
  };
}

function getMikufansTestPayload() {
  return {
    EventType: "FileOpening",
    EventTimestamp: new Date().toISOString(),
    EventId: "test-id-12345",
    EventData: {
      SessionId: "test-session-12345",
      RelativePath: "test_room/2026_01_13/录制-test-20260113-测试.flv",
      RoomId: 12345,
      Name: "测试主播",
      Title: "测试直播标题"
    }
  };
}

function sendTestRequest(path, data) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(data);
    
    const options = {
      hostname: 'localhost',
      port: testPort,
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 5000
    };
    
    const req = http.request(options, (res) => {
      let responseData = '';
      
      res.on('data', (chunk) => {
        responseData += chunk;
      });
      
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(responseData);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${responseData}`));
        }
      });
    });
    
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('请求超时'));
    });
    
    req.write(postData);
    req.end();
  });
}

async function runTests() {
  console.log('===========================================');
  console.log('   增强版Webhook服务器测试');
  console.log('===========================================');
  
  // 测试1: 检查服务器是否运行
  console.log('\n1. 检查服务器状态...');
  const isRunning = await testServerRunning();
  
  if (!isRunning) {
    console.log('\n⚠️  服务器未运行，请先启动:');
    console.log('   node src/scripts/webhook_server.js');
    console.log('\n或者使用PM2:');
    console.log('   pm2 start src/scripts/webhook_server.js --name ddtv-hook');
    return;
  }
  
  // 测试2: 测试端点响应
  console.log('\n2. 测试Webhook端点...');
  await testEndpointsResponse();
  
  // 测试3: 检查配置文件
  console.log('\n3. 检查配置文件...');
  try {
    const loadedConfig = configLoader.getConfig();
    console.log('✅ 配置文件加载成功');
    console.log(`   - 音频录制: ${loadedConfig.audio?.enabled ? '启用' : '禁用'}`);
    console.log(`   - DDTV: ${loadedConfig.webhook?.endpoints?.ddtv?.enabled ? '启用' : '禁用'}`);
    console.log(`   - mikufans: ${loadedConfig.webhook?.endpoints?.mikufans?.enabled ? '启用' : '禁用'}`);
  } catch (error) {
    console.log(`❌ 配置文件加载失败: ${error.message}`);
  }
  
  console.log('\n===========================================');
  console.log('   测试完成！');
  console.log('===========================================');
  
  console.log('\n📋 下一步:');
  console.log('1. 配置DDTV Webhook URL: http://localhost:15121/ddtv');
  console.log('2. 配置mikufans Webhook URL: http://localhost:15121/mikufans');
  console.log('3. 编辑 config.json 调整音频录制房间和超时参数');
  console.log('4. 查看详细文档: src/scripts/WEBHOOK_README.md');
}

// 运行测试
runTests().catch(console.error);