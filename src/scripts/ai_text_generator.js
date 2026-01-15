const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');

// 加载配置
function loadConfig() {
    const configPath = path.join(__dirname, 'config.json');
    const secretsPath = path.join(__dirname, 'config.secrets.json');
    const defaultConfig = {
        aiServices: {
            gemini: {
                enabled: true,
                apiKey: '',
                model: 'gemini-2.0-flash',
                temperature: 0.7,
                maxTokens: 2000
            },
            tuZi: {
                enabled: false,
                apiKey: '',
                model: 'gemini-3-flash-preview',
                baseUrl: 'https://api.tu-zi.com',
                temperature: 0.7,
                maxTokens: 2000
            }
        },
        timeouts: {
            aiApiTimeout: 60000
        }
    };

    try {
        // 加载主配置文件
        if (fs.existsSync(configPath)) {
            const userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            // 深度合并配置
            const merged = JSON.parse(JSON.stringify(defaultConfig));
            if (userConfig.aiServices?.gemini) {
                Object.assign(merged.aiServices.gemini, userConfig.aiServices.gemini);
            }
            if (userConfig.aiServices?.tuZi) {
                Object.assign(merged.aiServices.tuZi, userConfig.aiServices.tuZi);
            }
            if (userConfig.timeouts) {
                Object.assign(merged.timeouts, userConfig.timeouts);
            }
            
            // 加载密钥配置文件（如果存在）
            if (fs.existsSync(secretsPath)) {
                try {
                    const secretsConfig = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
                    // 支持新旧两种配置格式
                    if (secretsConfig.aiServices?.gemini?.apiKey) {
                        // 旧格式
                        merged.aiServices.gemini.apiKey = secretsConfig.aiServices.gemini.apiKey;
                    } else if (secretsConfig.ai?.text?.gemini?.apiKey) {
                        // 新格式
                        merged.aiServices.gemini.apiKey = secretsConfig.ai.text.gemini.apiKey;
                    }
                    
                    // 加载tuZi配置
                    if (secretsConfig.aiServices?.tuZi?.apiKey) {
                        merged.aiServices.tuZi.apiKey = secretsConfig.aiServices.tuZi.apiKey;
                    } else if (secretsConfig.ai?.comic?.tuZi?.apiKey) {
                        merged.aiServices.tuZi.apiKey = secretsConfig.ai.comic.tuZi.apiKey;
                    }
                } catch (secretsError) {
                    console.warn('警告: 无法加载密钥配置文件，API密钥将为空:', secretsError.message);
                }
            }
            
            return merged;
        }
    } catch (error) {
        console.error('Error loading AI config:', error);
    }
    return defaultConfig;
}

// 检查Gemini配置是否有效
function isGeminiConfigured() {
    const config = loadConfig();
    return config.aiServices.gemini.enabled &&
           config.aiServices.gemini.apiKey &&
           config.aiServices.gemini.apiKey.trim() !== '';
}

// 检查tuZi配置是否有效
function isTuZiConfigured() {
    const config = loadConfig();
    return config.aiServices.tuZi.enabled &&
           config.aiServices.tuZi.apiKey &&
           config.aiServices.tuZi.apiKey.trim() !== '';
}

// 生成不重复的文件名（如果文件已存在，添加 _1, _2 等后缀）
function generateUniqueFilename(basePath) {
    if (!fs.existsSync(basePath)) {
        return basePath;
    }
    
    const dir = path.dirname(basePath);
    const ext = path.extname(basePath);
    const nameWithoutExt = path.basename(basePath, ext);
    
    let counter = 1;
    let newPath;
    while (true) {
        newPath = path.join(dir, `${nameWithoutExt}_${counter}${ext}`);
        if (!fs.existsSync(newPath)) {
            return newPath;
        }
        counter++;
    }
}

// 读取AI_HIGHLIGHT.txt内容
function readHighlightFile(highlightPath) {
    try {
        return fs.readFileSync(highlightPath, 'utf8');
    } catch (error) {
        console.error(`❌ 读取AI_HIGHLIGHT文件失败: ${error.message}`);
        throw error;
    }
}
// 从文件名提取房间ID（如 26966466_...）
function extractRoomIdFromFilename(filename) {
    const m = filename.match(/^(\d+)_/);
    return m ? m[1] : null;
}

// 获取主播与粉丝名称（支持房间级覆盖与全局默认）
function getNames(roomId) {
    const configPath = path.join(__dirname, 'config.json');
    let anchor = '岁己SUI';
    let fan = '饼干岁';

    try {
        if (fs.existsSync(configPath)) {
            const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            if (cfg.aiServices) {
                if (cfg.aiServices.defaultAnchorName) anchor = cfg.aiServices.defaultAnchorName;
                if (cfg.aiServices.defaultFanName) fan = cfg.aiServices.defaultFanName;
            }
            if (roomId && cfg.roomSettings && cfg.roomSettings[roomId]) {
                const r = cfg.roomSettings[roomId];
                if (r.anchorName) anchor = r.anchorName;
                if (r.fanName) fan = r.fanName;
            }
        }
    } catch (e) {
        console.warn('警告: 读取配置以获取名称失败，使用默认名称', e.message);
    }

    return { anchor, fan };
}

// 构建提示词（支持传入 roomId 以使用房间级名称覆盖）
function buildPrompt(highlightContent, roomId) {
    const names = getNames(roomId);
    const anchor = names.anchor;
    const fan = names.fan;

    return `【角色设定】

身份：${anchor}的铁粉（自称"${fan}"或"${fan.replace(/岁$/, '')}"）。

性格：喜欢调侃、宠溺主播，有点话痨，对主播的生活琐事和梗如数家珍。

语气：亲昵、幽默、像老朋友一样聊天。常用语气词（如：哈哈、捏、嘛、呜呜），会使用直播间黑话（如：老己、漂亮饭、阿肯苦力等）。

【核心原则（最重要！）】

严格限定素材：只根据用户当前提供的文档/文本内容进行创作。绝对禁止混入该文档以外的任何已知信息、历史直播内容或互联网搜索结果（因为${anchor}的梗很多，AI容易串台，这一点必须强调）。

时效性：根据文档内容判断是早播、午播还是晚播，分别对应"早安"、"午安"或"晚安"的场景。

【写作结构与要素】

开场白：
格式：晚安/早安${anchor}！🌙/☀️
内容：一句话总结今天直播的整体感受（如：含金量极高、含梗量爆炸、辛苦了、被治愈了等）。

正文（核心内容回顾）：
抓细节：从文档中提取3-5个具体的直播亮点。
生活碎碎念（如：洗碗、理发、吃东西、身体不舒服、猫咪嘉嘉的趣事）。
直播事故/趣事（如：迟到理由、设备故障、口误、奇怪的脑洞）。
鉴赏/游戏环节（如：看了什么电影/视频、玩了什么游戏，主播的反应和吐槽）。
歌回：提到了哪些歌，唱得怎么样（好听/糊弄/搞笑）。
互动吐槽：针对上述细节进行粉丝视角的吐槽或夸奖（如:"只有你能干出这事"、"心疼小笨蛋"、"笑死我了")。

结尾（情感升华）：
关怀：叮嘱主播注意身体（嗓子、睡眠、吃饭），不要太累。
期待：确认下一次直播的时间（如果文档里提到了）。
落款：—— 永远爱你的/支持你的/陪着你的${fan} 🍪

字数要求：800字以内。

【直播内容摘要】
${highlightContent}

请根据以上直播内容，以${fan}的身份写一篇晚安回复。记住：只使用提供的直播内容，不要添加任何外部信息。`;
}

// 调用tuZi API生成文本（备用方案）
async function generateTextWithTuZi(prompt) {
    const config = loadConfig();
    const tuziConfig = config.aiServices.tuZi;
    
    if (!isTuZiConfigured()) {
        throw new Error('tuZi API未配置，请检查config.secrets.json中的apiKey');
    }
    
    console.log('🤖 调用tuZi API生成文本（Gemini超频备用方案）...');
    console.log(`   模型: ${tuziConfig.model}`);
    console.log(`   温度: ${tuziConfig.temperature}`);
    
    try {
        const baseUrl = tuziConfig.baseUrl || 'https://api.tu-zi.com';
        const apiUrl = `${baseUrl}/v1/chat/completions`;
        
        // 设置代理
        let agent = null;
        if (tuziConfig.proxy) {
            console.log(`   使用代理: ${tuziConfig.proxy}`);
            agent = new HttpsProxyAgent(tuziConfig.proxy);
        }
        
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${tuziConfig.apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: tuziConfig.model,
                messages: [
                    {
                        role: 'user',
                        content: prompt
                    }
                ],
                temperature: tuziConfig.temperature,
                max_tokens: tuziConfig.maxTokens
            }),
            agent: agent,
            timeout: 60000
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`tuZi API返回错误 ${response.status}: ${errorText}`);
        }
        
        const data = await response.json();
        const text = data.choices?.[0]?.message?.content;
        
        if (!text) {
            throw new Error('tuZi API返回空结果');
        }
        
        console.log('✅ tuZi API调用成功');
        return text;
    } catch (error) {
        console.error(`❌ tuZi API调用失败: ${error.message}`);
        throw error;
    }
}

// 调用Gemini API生成文本
async function generateTextWithGemini(prompt) {
    const config = loadConfig();
    const geminiConfig = config.aiServices.gemini;
    
    if (!isGeminiConfigured()) {
        throw new Error('Gemini API未配置，请检查config.secrets.json中的apiKey');
    }
    
    console.log('🤖 调用Gemini API生成文本...');
    console.log(`   模型: ${geminiConfig.model}`);
    console.log(`   温度: ${geminiConfig.temperature}`);
    
    let originalFetch = null;
    try {
        // --- 核心修改开始 ---
        // SDK 不支持在构造函数传 agent，我们需要劫持全局 fetch 来注入代理
        if (geminiConfig.proxy) {
            console.log(`   使用代理: ${geminiConfig.proxy}`);
            const agent = new HttpsProxyAgent(geminiConfig.proxy);

            // 临时覆盖全局 fetch，强制让 SDK 走 node-fetch 并带上 agent
            // 注意：这是一种 Hack 方式，但兼容性最好
            originalFetch = global.fetch;
            global.fetch = (url, init) => {
                return fetch(url, {
                    ...init,
                    agent: agent
                });
            };
        }
        // --- 核心修改结束 ---

        // 注意：这里只传 apiKey，不要传 fetchOptions，因为无效
        const genAI = new GoogleGenerativeAI(geminiConfig.apiKey);
        const model = genAI.getGenerativeModel({
            model: geminiConfig.model,
            generationConfig: {
                temperature: geminiConfig.temperature,
                maxOutputTokens: geminiConfig.maxTokens,
            }
        });
        
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();

        // 恢复原始 fetch（如果被覆盖了）
        if (originalFetch !== null) {
            global.fetch = originalFetch;
        }

        console.log('✅ Gemini API调用成功');
        return text;
    } catch (error) {
        // 恢复原始 fetch（如果被覆盖了）
        if (originalFetch !== null) {
            global.fetch = originalFetch;
        }
        
        // 检查是否是429超频错误
        const errorMessage = error.message || '';
        const is429Error = errorMessage.includes('429') || 
                          errorMessage.includes('Too Many Requests') ||
                          errorMessage.includes('RESOURCE_EXHAUSTED') ||
                          errorMessage.includes('quota');
        
        if (is429Error && isTuZiConfigured()) {
            console.warn(`⚠️  Gemini API超频 (429)，尝试使用tuZi API作为备用方案...`);
            try {
                return await generateTextWithTuZi(prompt);
            } catch (tuziError) {
                console.error(`❌ tuZi API备用方案也失败: ${tuziError.message}`);
                throw new Error(`Gemini和tuZi API都失败: Gemini - ${error.message}, tuZi - ${tuziError.message}`);
            }
        }
        
        console.error(`❌ Gemini API调用失败: ${error.message}`);
        throw error;
    }
}

// 保存生成的文本
function saveGeneratedText(outputPath, text, highlightPath) {
    try {
        // 生成不重复的文件名
        const uniquePath = generateUniqueFilename(outputPath);
        
        // 添加元信息
        const highlightName = path.basename(highlightPath);
        const timestamp = new Date().toLocaleString('zh-CN');
        const metaInfo = `# 晚安回复（基于${highlightName}）
生成时间: ${timestamp}
---
        
`;
        
        const fullText = metaInfo + text;
        fs.writeFileSync(uniquePath, fullText, 'utf8');
        console.log(`✅ 晚安回复已保存: ${path.basename(uniquePath)}`);
        return uniquePath;
    } catch (error) {
        console.error(`❌ 保存生成文本失败: ${error.message}`);
        throw error;
    }
}

// 生成晚安回复
async function generateGoodnightReply(highlightPath) {
    const config = loadConfig();
    
    if (!config.aiServices.gemini.enabled) {
        console.log('ℹ️  AI文本生成功能已禁用');
        return null;
    }
    
    if (!isGeminiConfigured()) {
        console.log('⚠️  Gemini API未配置，使用本地回退生成晚安回复');

        // 本地回退：简单根据文本摘取亮点并生成一段固定模板的晚安回复，便于无API时验证流程
        try {
            const highlightContent = readHighlightFile(highlightPath);
            const lines = highlightContent.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
            const picks = lines.slice(0, 5).map((l, i) => `${i+1}. ${l}`);
            const fallback = `# 晚安（本地回退）\n\n今天的直播亮点:\n${picks.join('\n')}\n\n谢谢今天的陪伴，晚安~`;
            const dir = path.dirname(highlightPath);
            const baseName = path.basename(highlightPath, '_AI_HIGHLIGHT.txt');
            const outputPath = path.join(dir, `${baseName}_晚安回复.md`);
            saveGeneratedText(outputPath, fallback, highlightPath);
            return outputPath;
        } catch (e) {
            console.error('⚠️ 本地回退生成失败:', e.message);
            return null;
        }
    }
    
    console.log(`📄 处理AI_HIGHLIGHT文件: ${path.basename(highlightPath)}`);
    
    try {
        // 检查输入文件
        if (!fs.existsSync(highlightPath)) {
            throw new Error(`AI_HIGHLIGHT文件不存在: ${highlightPath}`);
        }
        
        // 读取内容
        const highlightContent = readHighlightFile(highlightPath);
        console.log(`📖 读取内容完成 (${highlightContent.length} 字符)`);
        
        // 构建提示词（尝试从环境或文件名获取 roomId 以使用房间级名称覆盖）
        const envRoomId = process.env.ROOM_ID || null;
        const fileRoomId = extractRoomIdFromFilename(path.basename(highlightPath));
        const roomId = envRoomId || fileRoomId;
        // 构建提示词
        const prompt = buildPrompt(highlightContent, roomId);
        
        // 调用API生成文本
        const generatedText = await generateTextWithGemini(prompt);
        
        // 确定输出路径
        const dir = path.dirname(highlightPath);
        const baseName = path.basename(highlightPath, '_AI_HIGHLIGHT.txt');
        const outputPath = path.join(dir, `${baseName}_晚安回复.md`);
        
        // 保存结果
        return saveGeneratedText(outputPath, generatedText, highlightPath);
        
    } catch (error) {
        console.error(`❌ 生成晚安回复失败: ${error.message}`);
        return null;
    }
}

// 批量处理目录中的所有AI_HIGHLIGHT文件
async function batchGenerateGoodnightReplies(directory) {
    try {
        const files = fs.readdirSync(directory);
        const highlightFiles = files.filter(f => f.includes('_AI_HIGHLIGHT.txt'));
        
        console.log(`🔍 在目录中发现 ${highlightFiles.length} 个AI_HIGHLIGHT文件`);
        
        const results = [];
        for (const file of highlightFiles) {
            const filePath = path.join(directory, file);
            console.log(`\n--- 处理: ${file} ---`);
            
            try {
                const result = await generateGoodnightReply(filePath);
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
    isGeminiConfigured,
    isTuZiConfigured,
    generateGoodnightReply,
    generateTextWithGemini,
    generateTextWithTuZi,
    batchGenerateGoodnightReplies
};

// 命令行测试
if (require.main === module) {
    const args = process.argv.slice(2);
    
    if (args.length === 0) {
        console.log('用法:');
        console.log('  1. 处理单个文件: node ai_text_generator.js <AI_HIGHLIGHT.txt路径>');
        console.log('  2. 批量处理目录: node ai_text_generator.js --batch <目录路径>');
        console.log('  3. 生成文本并输出原始内容: node ai_text_generator.js --generate-text [<promptFilePath>|-]');
        process.exit(1);
    }
    
    (async () => {
        try {
            if (args[0] === '--batch' && args[1]) {
                await batchGenerateGoodnightReplies(args[1]);
            } else if (args[0] === '--generate-text') {
                // args[1] may be a file path, '-' for stdin, or omitted (read stdin)
                const promptSource = args[1];
                let prompt = '';
                if (!promptSource || promptSource === '-') {
                    // read from stdin
                    prompt = await new Promise((resolve, reject) => {
                        let data = '';
                        process.stdin.setEncoding('utf8');
                        process.stdin.on('data', chunk => data += chunk);
                        process.stdin.on('end', () => resolve(data));
                        process.stdin.on('error', err => reject(err));
                    });
                } else {
                    // read from file
                    if (!fs.existsSync(promptSource)) {
                        throw new Error(`提示词文件不存在: ${promptSource}`);
                    }
                    prompt = fs.readFileSync(promptSource, 'utf8');
                }

                const generated = await generateTextWithGemini(prompt);
                // print raw generated text to stdout
                process.stdout.write(generated + '\n');
            } else {
                const result = await generateGoodnightReply(args[0]);
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
