#!/usr/bin/env node

/**
 * 队列管理器测试脚本
 * 用于验证持久化队列的功能
 */

const queueManager = require('./whisper_queue_manager');
const path = require('path');

console.log('===========================================');
console.log('      Whisper 队列管理器测试              ');
console.log('===========================================\n');

// 测试1: 添加任务
console.log('📝 测试1: 添加任务到队列\n');
const task1 = queueManager.addTask('D:\\Videos\\test1.flv', '12345');
const task2 = queueManager.addTask('D:\\Videos\\test2.flv', '12345');
const task3 = queueManager.addTask('D:\\Videos\\test3.flv', '67890');

// 测试2: 显示队列状态
console.log('\n📊 测试2: 显示队列状态\n');
queueManager.printStatus();

// 测试3: 标记任务为处理中
console.log('\n🔄 测试3: 标记任务为处理中\n');
queueManager.markProcessing(task1.id);
queueManager.printStatus();

// 测试4: 标记任务完成
console.log('\n✅ 测试4: 标记任务完成\n');
queueManager.markCompleted(task1.id);
queueManager.printStatus();

// 测试5: 标记任务失败
console.log('\n❌ 测试5: 标记任务失败\n');
queueManager.markProcessing(task2.id);
queueManager.markFailed(task2.id, '测试错误信息');
queueManager.printStatus();

// 测试6: 恢复中断的任务
console.log('\n🔄 测试6: 模拟重启恢复\n');
queueManager.markProcessing(task3.id);
console.log('模拟程序重启...\n');
queueManager.recoverInterruptedTasks();
queueManager.printStatus();

// 测试7: 获取统计信息
console.log('\n📈 测试7: 队列统计信息\n');
const stats = queueManager.getStats();
console.log('统计信息:', stats);

console.log('\n===========================================');
console.log('      测试完成！                          ');
console.log('===========================================');
console.log('\n💡 提示: 查看 src/scripts/.whisper_queue.json 文件查看持久化数据');
