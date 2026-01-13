const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// 加载配置
function loadConfig() {
    const configPath = path.join(__dirname, 'config.json');
    const secretsPath = path.join(__dirname, 'config.secrets.json');
    const defaultConfig = {
        aiServices: {
            huggingFace: {
                enabled: true,
                apiToken: '',
                comicFactoryModel: "jbilcke-hf/ai-comic-factory"
            }
        }
    };

    try {
        // 加载主配置文件
        if (fs.existsSync(configPath)) {
            const userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            const merged = JSON.parse(JSON.stringify(defaultConfig));
            if (userConfig.aiServices?.huggingFace) {
                Object.assign(merged.aiServices.huggingFace, userConfig.aiServices.huggingFace);
            }
            
            // 加载密钥配置文件（如果存在）
            if (fs.existsSync(secretsPath)) {
                try {
                    const secretsConfig = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
                    if (secretsConfig.aiServices?.huggingFace?.apiToken) {
                        merged.aiServices.huggingFace.apiToken = secretsConfig.aiServices.huggingFace.apiToken;
                    }
                } catch (secretsError) {
                    console.warn('警告: 无法加载密钥配置文件，API令牌将为空:', secretsError.message);
                }
            }
            
            return merged;
        }
    } catch (error) {
        console.error('Error loading AI comic config:', error);
    }
    return defaultConfig;
}

// 检查配置是否有效
function isComicGenerationEnabled() {
    const config = loadConfig();
    return config.aiServices.huggingFace.enabled;
}

// 调用Python脚本生成漫画
async function generateComicWithPython(highlightPath) {
    const pythonScript = path.join(__dirname, 'ai_comic_generator.py');
    
    if (!fs.existsSync(pythonScript)) {
        throw new Error(`Python脚本不存在: ${pythonScript}`);
    }
    
    console.log(`🐍 调用Python脚本生成漫画: ${path.basename(highlightPath)}`);
    
    return new Promise((resolve, reject) => {
        const pythonProcess = spawn('python', [pythonScript, highlightPath], {
            stdio: 'pipe',
            env: { ...process.env, PYTHONUTF8: '1' }
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
        setTimeout(() => {
            pythonProcess.kill('SIGTERM');
            reject(new Error('Python脚本执行超时'));
        }, 300000); // 5分钟超时
    });
}

// 生成漫画
async function generateComicFromHighlight(highlightPath) {
    const config = loadConfig();
    
    if (!config.aiServices.huggingFace.enabled) {
        console.log('ℹ️  AI漫画生成功能已禁用');
        return null;
    }
    
    console.log(`🎨 开始生成漫画: ${path.basename(highlightPath)}`);
    
    try {
        // 检查输入文件
        if (!fs.existsSync(highlightPath)) {
            throw new Error(`AI_HIGHLIGHT文件不存在: ${highlightPath}`);
        }
        
        // 调用Python脚本
        const result = await generateComicWithPython(highlightPath);
        
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
        const highlightFiles = files.filter(f => f.includes('_AI_HIGHLIGHT.txt'));
        
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
    loadConfig,
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