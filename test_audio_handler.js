#!/usr/bin/env node

/**
 * 测试音频文件处理器
 */

const http = require('http');

const API_HOST = 'localhost';
const API_PORT = 12523; // Webhook服务端口

// 测试数据
const testCases = [
  {
    name: '测试1: 标准音频文件',
    filePath: '录制-1741667419-20260116-192814-176-浣熊咖啡厅正式营业！.m4a'
  },
  {
    name: '测试2: 另一个主播的音频文件',
    filePath: '录制-25788785-20260115-194314-692-找你有事！速来.m4a'
  },
  {
    name: '测试3: 音频为mp3格式',
    filePath: '录制-1713548468-20260116-195937-155-第一次任务开始啦~.mp3'
  }
];

/**
 * 发送请求到API
 */
function sendRequest(endpoint, data) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: API_HOST,
      port: API_PORT,
      path: endpoint,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const req = http.request(options, (res) => {
      let responseData = '';

      res.on('data', (chunk) => {
        responseData += chunk;
      });

      res.on('end', () => {
        try {
          const parsed = JSON.parse(responseData);
          resolve({
            statusCode: res.statusCode,
            body: parsed
          });
        } catch (e) {
          resolve({
            statusCode: res.statusCode,
            body: responseData
          });
        }
      });
    });

    req.on('error', (e) => {
      reject(e);
    });

    req.write(JSON.stringify(data));
    req.end();
  });
}

/**
 * 运行测试
 */
async function runTests() {
  console.log('========================================');
  console.log('音频文件处理器API测试');
  console.log('========================================\n');

  console.log(`目标API: http://${API_HOST}:${API_PORT}/audio`);
  console.log(`测试时间: ${new Date().toLocaleString()}\n`);

  // 先测试健康检查
  console.log('1. 测试健康检查...');
  try {
    const healthRes = await sendRequest('/audio/test', {});
    console.log('✓ 健康检查成功');
    console.log('  响应:', JSON.stringify(healthRes.body, null, 2));
  } catch (e) {
    console.error('✗ 健康检查失败:', e.message);
    console.log('  提示: 请确保Webhook服务已启动在端口 12523');
    return;
  }

  console.log('\n2. 测试音频文件处理...\n');

  // 测试各个用例
  for (let i = 0; i < testCases.length; i++) {
    const testCase = testCases[i];
    console.log(`${i + 1}. ${testCase.name}`);
    console.log(`   文件路径: ${testCase.filePath}`);

    try {
      const response = await sendRequest('/audio', {
        filePath: testCase.filePath
      });

      console.log(`   状态码: ${response.statusCode}`);
      console.log(`   响应:`);
      console.log('   ' + JSON.stringify(response.body, null, 2).split('\n').join('\n   '));

      if (response.body.success) {
        console.log('   ✓ 成功\n');
      } else {
        console.log(`   ✗ 失败: ${response.body.error}\n`);
      }
    } catch (e) {
      console.error(`   ✗ 错误: ${e.message}\n`);
    }
  }

  console.log('========================================');
  console.log('测试完成');
  console.log('========================================');
}

// 运行测试
runTests().catch(console.error);
