const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const configLoader = require('./config-loader');

const GENERATION_LOCK_TIMEOUT_MS = 30 * 60 * 1000;
const GENERATION_LOCK_WAIT_MS = 20 * 60 * 1000;
const GENERATION_LOCK_POLL_MS = 3000;

// 检查配置是否有效
function isComicGenerationEnabled() {
    const config = configLoader.getConfig();
    return config.ai?.comic?.enabled !== false;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getExistingGeneratedFile(basePath) {
    if (fs.existsSync(basePath)) {
        return basePath;
    }

    const dir = path.dirname(basePath);
    const ext = path.extname(basePath);
    const nameWithoutExt = path.basename(basePath, ext);

    if (!fs.existsSync(dir)) {
        return null;
    }

    const escapedName = nameWithoutExt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedExt = ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^${escapedName}_(\\d+)${escapedExt}$`);

    return fs.readdirSync(dir)
        .filter(file => pattern.test(file))
        .map(file => path.join(dir, file))
        .sort((a, b) => {
            try {
                return fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs;
            } catch {
                return a.localeCompare(b);
            }
        })[0] || null;
}

function acquireGenerationLock(lockPath) {
    try {
        const fd = fs.openSync(lockPath, 'wx');
        fs.writeFileSync(fd, JSON.stringify({
            pid: process.pid,
            createdAt: new Date().toISOString()
        }));
        fs.closeSync(fd);
        return true;
    } catch (error) {
        if (error.code !== 'EEXIST') {
            throw error;
        }

        try {
            const age = Date.now() - fs.statSync(lockPath).mtimeMs;
            if (age > GENERATION_LOCK_TIMEOUT_MS) {
                fs.unlinkSync(lockPath);
                return acquireGenerationLock(lockPath);
            }
        } catch (statError) {
            if (statError.code === 'ENOENT') {
                return acquireGenerationLock(lockPath);
            }
            throw statError;
        }

        return false;
    }
}

async function waitForGeneratedFile(basePath, lockPath) {
    const start = Date.now();
    while (Date.now() - start < GENERATION_LOCK_WAIT_MS) {
        const existing = getExistingGeneratedFile(basePath);
        if (existing) {
            return existing;
        }

        if (!fs.existsSync(lockPath)) {
            return getExistingGeneratedFile(basePath);
        }

        await sleep(GENERATION_LOCK_POLL_MS);
    }

    return null;
}

function releaseGenerationLock(lockPath) {
    try {
        fs.unlinkSync(lockPath);
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.warn(`⚠️  删除漫画生成锁失败: ${error.message}`);
        }
    }
}

// 调用Python脚本生成漫画
async function generateComicWithPython(highlightPath, roomId = null) {
    const pythonScript = path.join(__dirname, 'ai_comic_generator.py');

    if (!fs.existsSync(pythonScript)) {
        throw new Error(`Python脚本不存在: ${pythonScript}`);
    }

    console.log(`🐍 调用Python脚本生成漫画: ${path.basename(highlightPath)}`);

    // 使用正确的Python路径（优先使用环境变量，否则使用默认路径）
    const pythonPath = process.env.PYTHON_PATH || 'D:\\develop\\Python\\python.exe';

    return new Promise((resolve, reject) => {
        // 构建命令行参数
        const args = [pythonScript, highlightPath];
        if (roomId) {
            args.push('--room-id', roomId);
        }
        
        const pythonProcess = spawn(pythonPath, args, {
            stdio: 'pipe',
            windowsHide: true,
            env: { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' }
        });

        let stdout = '';
        let stderr = '';

        pythonProcess.stdout.on('data', (data) => {
            stdout += data.toString();
            process.stdout.write(data.toString());
        });

        pythonProcess.stderr.on('data', (data) => {
            stderr += data.toString();
            process.stderr.write(data.toString());
        });

        pythonProcess.on('close', (code) => {
            if (code === 0) {
                // 从输出中提取生成的文件路径
                const match = stdout.match(/输出文件:\s*(.+\.(png|jpg|jpeg|txt))/);
                if (match) {
                    resolve(match[1].trim());
                } else {
                    // 检查是否生成了_COMIC_FACTORY文件
                    const dir = path.dirname(highlightPath);
                    const baseName = path.basename(highlightPath, '_AI_HIGHLIGHT.txt');
                    const possibleFiles = [
                        path.join(dir, `${baseName}_COMIC_FACTORY.png`),
                        path.join(dir, `${baseName}_COMIC_FACTORY.jpg`),
                        path.join(dir, `${baseName}_COMIC_FACTORY.jpeg`),
                        path.join(dir, `${baseName}_COMIC_FACTORY.txt`)
                    ];

                    for (const file of possibleFiles) {
                        if (fs.existsSync(file)) {
                            resolve(file);
                            return;
                        }
                    }

                    resolve(null);
                }
            } else {
                reject(new Error(`Python脚本执行失败，退出码: ${code}\n${stderr}`));
            }
        });

        pythonProcess.on('error', (err) => {
            reject(new Error(`启动Python进程失败: ${err.message}`));
        });

        // 设置超时
        const pythonTimeoutMs = 1000 * 4 * 1000;
        setTimeout(() => {
            pythonProcess.kill('SIGTERM');
            reject(new Error('Python脚本执行超时'));
        }, pythonTimeoutMs); // 里面 gpt-image-2 单次可到 1000 秒，外层同步放宽
    });
}

// 生成漫画
async function generateComicFromHighlight(highlightPath, roomId = null) {
    if (!isComicGenerationEnabled()) {
        console.log('ℹ️  AI漫画生成功能已禁用');
        return null;
    }

    console.log(`🎨 开始生成漫画: ${path.basename(highlightPath)}`);

    try {
        // 检查输入文件
        if (!fs.existsSync(highlightPath)) {
            throw new Error(`AI_HIGHLIGHT文件不存在: ${highlightPath}`);
        }

        const dir = path.dirname(highlightPath);
        const baseName = path.basename(highlightPath, '_AI_HIGHLIGHT.txt');
        const outputPath = path.join(dir, `${baseName}_COMIC_FACTORY.png`);
        const lockPath = `${outputPath}.lock`;
        const existingOutput = getExistingGeneratedFile(outputPath);

        if (existingOutput) {
            console.log(`ℹ️  漫画已存在，跳过重复生成: ${path.basename(existingOutput)}`);
            return existingOutput;
        }

        const lockAcquired = acquireGenerationLock(lockPath);
        if (!lockAcquired) {
            console.log(`⏳ 漫画正在由其他进程生成，等待结果: ${path.basename(outputPath)}`);
            const generatedByOtherProcess = await waitForGeneratedFile(outputPath, lockPath);
            if (generatedByOtherProcess) {
                console.log(`✅ 复用其他进程生成的漫画: ${path.basename(generatedByOtherProcess)}`);
                return generatedByOtherProcess;
            }

            console.log('⚠️  等待漫画生成超时，跳过本次重复生成');
            return null;
        }

        let result = null;
        try {
            // 调用Python脚本
            result = await generateComicWithPython(highlightPath, roomId);
        } finally {
            releaseGenerationLock(lockPath);
        }

        if (result) {
            console.log(`✅ 漫画生成完成: ${path.basename(result)}`);
            return result;
        } else {
            console.log('⚠️  漫画生成完成但未找到输出文件');
            return null;
        }

    } catch (error) {
        console.error(`❌ 漫画生成失败: ${error.message}`);
        return null;
    }
}

// 批量生成漫画
async function batchGenerateComics(directory) {
    try {
        const files = fs.readdirSync(directory);
        const highlightFiles = files.filter(f => f.endsWith('_AI_HIGHLIGHT.txt'));

        console.log(`🔍 在目录中发现 ${highlightFiles.length} 个AI_HIGHLIGHT文件`);

        const results = [];
        for (const file of highlightFiles) {
            const filePath = path.join(directory, file);
            console.log(`\n--- 处理: ${file} ---`);

            try {
                const result = await generateComicFromHighlight(filePath);
                if (result) {
                    results.push({ file, success: true, output: result });
                } else {
                    results.push({ file, success: false, error: '生成失败' });
                }
            } catch (error) {
                console.error(`处理 ${file} 时出错: ${error.message}`);
                results.push({ file, success: false, error: error.message });
            }
        }

        // 输出统计信息
        const successCount = results.filter(r => r.success).length;
        const failCount = results.filter(r => !r.success).length;

        console.log(`\n📊 批量处理完成:`);
        console.log(`   ✅ 成功: ${successCount} 个`);
        console.log(`   ❌ 失败: ${failCount} 个`);

        return results;
    } catch (error) {
        console.error(`❌ 批量处理失败: ${error.message}`);
        throw error;
    }
}

// 导出函数
module.exports = {
    isComicGenerationEnabled,
    generateComicFromHighlight,
    batchGenerateComics
};

// 命令行测试
if (require.main === module) {
    const args = process.argv.slice(2);

    if (args.length === 0) {
        console.log('用法:');
        console.log('  1. 处理单个文件: node ai_comic_generator.js <AI_HIGHLIGHT.txt路径>');
        console.log('  2. 批量处理目录: node ai_comic_generator.js --batch <目录路径>');
        process.exit(1);
    }

    (async () => {
        try {
            if (args[0] === '--batch' && args[1]) {
                await batchGenerateComics(args[1]);
            } else {
                const result = await generateComicFromHighlight(args[0]);
                if (result) {
                    console.log(`\n🎉 处理完成，输出文件: ${result}`);
                } else {
                    console.log('\nℹ️  未生成任何文件');
                }
            }
        } catch (error) {
            console.error(`💥 处理失败: ${error.message}`);
            process.exit(1);
        }
    })();
}
