const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');
const configLoader = require('./config-loader');

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

// 构建提示词（支持传入 roomId 以使用房间级名称覆盖）
function buildPrompt(highlightContent, roomId) {
    const names = configLoader.getNames(roomId);
    const anchor = names.anchor;
    const fan = names.fan;
    const wordLimit = configLoader.getWordLimit(roomId);

    // 检查是否有自定义配置 (保持原有逻辑)
    const config = configLoader.getConfig();
    const roomSettings = config?.ai?.roomSettings || {};
    const roomConfig = roomId ? roomSettings[String(roomId)] : null;
    const customPrompt = roomConfig?.customPrompts?.goodnightReply;

    if (customPrompt) {
        return customPrompt
            .replace(/{anchor}/g, anchor)
            .replace(/{fan}/g, fan)
            .replace(/{wordLimit}/g, wordLimit)
            .replace(/{highlightContent}/g, highlightContent);
    }

    // --- 核心修改：全肯定萌萌人 2.0 ---

    // 定义几种不同的“夸奖角度”，防止每天都只会说“含金量”
    const praiseAngles = [
        '角度A（心疼路线）：侧重于觉得主播今天很辛苦/很努力，表达关心和陪伴。',
        '角度B（爆笑路线）：侧重于觉得今天节目效果太好了，全是梗，笑得肚子疼。',
        '角度C（细节路线）：侧重于捕捉主播无意间的一个可爱小动作或一句话进行“过度解读”和夸奖。',
        '角度D（崇拜路线）：侧重于夸赞主播的歌力/游戏技术/杂谈能力，带有粉丝滤镜的彩虹屁。'
    ];
    const randomAngle = praiseAngles[Math.floor(Math.random() * praiseAngles.length)];

    const mainPrompts = [`性格：
1. **全肯定**：自带800米厚的粉丝滤镜，主播干啥都觉得可爱/厉害。
2. **宠溺**：语气要软，要有亲切感，把主播当成家里人或特别亲近的朋友。
3. **萌萌人**：可以使用颜文字 ( ´∀\`)，语气词（捏、呀、嘛、呜呜），但要自然点。

【当前任务】
根据提供的直播内容，写一段晚安回复。
**今日夸奖切入点**：${randomAngle}

【写作要求】
1. **拒绝机械感**：不要像写总结报告一样列123点。要像在发朋友圈或发弹幕一样，把几个亮点揉在一起说。
2. **要有画面感**：如果文档里提到了具体的梗，一定要提一句，证明你真的看了。
3. **情感浓度**：虽然禁止了某些词，但"喜欢"和"支持"的情绪要给足。如果主播今天很累，就多安慰；如果很开心，就跟着一起傻乐。
`,
`

性格：喜欢调侃、宠溺主播，有点话痨，对主播的生活琐事和梗如数家珍。

语气：亲昵、幽默、像老朋友一样聊天。常用语气词（如：哈哈、捏、嘛、呜呜），会使用直播间弹幕黑话。

【核心原则（最重要！）】

严格限定素材：只根据用户当前提供的文档/文本内容进行创作。绝对禁止混入该文档以外的任何已知信息、历史直播内容或互联网搜索结果（因为${anchor}的梗很多，AI容易串台，这一点必须强调）。

时效性：根据文档内容判断是早播、午播还是晚播，分别对应"早安"、"午安"或"晚安"的场景。

【写作结构与要素】

开场白：
格式：晚安/早安xx（用昵称）！🌙/☀️
内容：一句话总结今天直播的整体感受（如：含金量极高、含梗量爆炸、辛苦了、被治愈了等）。

正文（核心内容回顾）：
抓细节：从文档中提取3-5个具体的直播亮点。
生活碎碎念（如：洗碗、吃东西、身体不舒服、猫咪的趣事）。
直播事故/趣事（如：迟到理由、设备故障、口误、奇怪的脑洞）。
鉴赏/游戏环节（如：看了什么电影/视频、玩了什么游戏，主播的反应和吐槽）。
歌回：提到了哪些歌，唱得怎么样（好听/糊弄/搞笑）。
互动吐槽：针对上述细节进行粉丝视角的吐槽或夸奖（如:"只有你能干出这事"、"心疼小笨蛋"、"笑死我了")。

结尾（情感升华）：
关怀：叮嘱主播注意身体（嗓子、睡眠、吃饭），不要太累。
期待：确认下一次直播的时间（如果文档里提到了）。`
];

    const randomMainPrompt = mainPrompts[Math.floor(Math.random() * mainPrompts.length)];

    const result = `【角色设定】
身份：${anchor}的铁粉（自称"${fan}"）。

${randomMainPrompt}

【字数与格式】
字数：${wordLimit}字以内。
格式：不要太长，适合手机阅读。

【直播内容（主播语音转写+观众弹幕）】
${highlightContent}

请根据直播内容，以${fan}的身份写一篇晚安回复。记住：只使用提供的直播内容，不要添加任何外部信息。`;

    console.log('晚安动态prompt主要内容:', randomMainPrompt.substring(0, 100), '直播内容长度:', highlightContent.length);
    return result;
}

// 调用tuZi API生成文本（备用方案）
async function generateTextWithTuZi(prompt) {
    const config = configLoader.getConfig();
    // 优先使用 ai.text.tuZi 配置（文本生成专用），其次使用 ai.comic.tuZi（兼容旧配置）
    const tuziConfig = config.ai?.text?.tuZi || config.aiServices?.tuZi || {};

    if (!configLoader.isTuZiConfigured()) {
        throw new Error('tuZi API未配置，请检查secrets.json中的apiKey');
    }

    console.log('🤖 调用tuZi API生成文本（Gemini超频备用方案）...');

    const maxRetries = 3;
    const baseUrl = tuziConfig.baseUrl || 'https://api.tu-zi.com';
    const apiUrl = `${baseUrl}/v1/chat/completions`;

    // 设置代理
    let agent = null;
    if (tuziConfig.proxy) {
        console.log(`   使用代理: ${tuziConfig.proxy}`);
        agent = new HttpsProxyAgent(tuziConfig.proxy);
    }

    // 重试逻辑
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            let textModel = tuziConfig.model || 'gemini-3-flash-preview';

            // 根据重试次数切换模型
            if (attempt === 1) {
                textModel = 'o3-mini';
            } else if (attempt === 2) {
                textModel = 'gemini-3-pro';
            } else if (attempt === 3) {
                textModel = 'claude-haiku-4-5-20251001';
            }

            console.log(`[WAIT] 正在通过tu-zi.com API生成文本... (尝试 ${attempt + 1}/${maxRetries + 1} model: ${textModel}, 超时: 60s)`);

            // 获取超时时间 (默认 60 秒)
            const timeoutMs = config.timeouts?.aiApiTimeout || 60000;

            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${tuziConfig.apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: textModel,
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
                timeout: timeoutMs
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`tuZi API返回错误 ${response.status}: ${errorText}`);
            }

            const data = await response.json();
            const text = data.choices?.[0]?.message?.content;

            if (!text || text.trim().length === 0) {
                throw new Error('tuZi API返回空结果');
            }

            console.log('✅ tuZi API调用成功');
            return text.trim();
        } catch (error) {
            console.error(`❌ tuZi API调用失败 (尝试 ${attempt + 1}/${maxRetries + 1}): ${error.message}`);

            // 如果是最后一次尝试，抛出错误
            if (attempt === maxRetries) {
                throw error;
            }

            // 等待一小段时间后重试
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}

// 调用Gemini API生成文本
async function generateTextWithGemini(prompt) {
    const config = configLoader.getConfig();
    const geminiConfig = config.aiServices?.gemini || config.ai?.text?.gemini || {};

    if (!configLoader.isGeminiConfigured()) {
        throw new Error('Gemini API未配置，请检查secrets.json中的apiKey');
    }

    console.log('🤖 调用Gemini API生成文本...');
    console.log(`   模型: ${geminiConfig.model}`);
    console.log(`   温度: ${geminiConfig.temperature}`);

    let originalFetch = null;
    try {
        // 获取超时时间 (默认 90 秒)
        const timeoutMs = config.timeouts?.aiApiTimeout || 90000;
        console.log(`   超时设置: ${timeoutMs / 1000}s`);

        // --- 核心修改开始 ---
        // SDK 不支持在构造函数传 agent，我们需要劫持全局 fetch 来注入代理
        if (geminiConfig.proxy) {
            console.log(`   使用代理: ${geminiConfig.proxy}`);
            const agent = new HttpsProxyAgent(geminiConfig.proxy);

            // 临时覆盖全局 fetch，强制让 SDK 走 node-fetch 并带上 agent 和 timeout
            originalFetch = global.fetch;
            global.fetch = (url, init) => {
                return fetch(url, {
                    ...init,
                    agent: agent,
                    timeout: timeoutMs // node-fetch 支持 timeout 选项
                });
            };
        }
        // --- 核心修改结束 ---

        const genAI = new GoogleGenerativeAI(geminiConfig.apiKey);
        const model = genAI.getGenerativeModel({
            model: geminiConfig.model,
            generationConfig: {
                temperature: geminiConfig.temperature,
                maxOutputTokens: geminiConfig.maxTokens,
            }
        });
        
        // 使用 Promise.race 实现外部超时控制，双重保障
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`Gemini API 调用超时 (${timeoutMs / 1000}s)`)), timeoutMs);
        });

        const apiPromise = (async () => {
            const result = await model.generateContent(prompt);
            const response = await result.response;
            return response.text();
        })();

        const text = await Promise.race([apiPromise, timeoutPromise]);

        if (!text || text.trim().length === 0) {
            throw new Error('Gemini API返回结果为空');
        }

        // 恢复原始 fetch（如果被覆盖了）
        if (originalFetch !== null) {
            global.fetch = originalFetch;
        }

        console.log('✅ Gemini API调用成功');
        return text.trim();
    } catch (error) {
        // 恢复原始 fetch（如果被覆盖了）
        if (originalFetch !== null) {
            global.fetch = originalFetch;
        }

        // 不管什么 Gemini 错误，都尝试使用 tuZi API 重试
        if (configLoader.isTuZiConfigured()) {
            console.warn(`⚠️  Gemini API调用失败 (${error.message})，尝试使用tuZi API作为备用方案...`);
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
        const metaInfo = ``;

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
async function generateGoodnightReply(highlightPath, roomId = null) {
    const config = configLoader.getConfig();

    const geminiConfig = config.ai?.text?.gemini || config.aiServices?.gemini || {};
    const textEnabled = config.ai?.text?.enabled !== false;
    const geminiEnabled = geminiConfig.enabled !== false;

    console.log(`🔍 检查AI文本生成配置...`);
    console.log(`   总开关 (ai.text.enabled): ${textEnabled ? '启用' : '禁用'}`);
    console.log(`   Gemini开关 (gemini.enabled): ${geminiEnabled ? '启用' : '禁用'}`);
    console.log(`   当前服务商: ${config.ai?.text?.provider || 'gemini'}`);
    console.log(`   isGeminiConfigured: ${configLoader.isGeminiConfigured()}`);
    console.log(`   isTuZiConfigured: ${configLoader.isTuZiConfigured()}`);

    if (!textEnabled || (!geminiEnabled && config.ai?.text?.provider === 'gemini')) {
        console.log('ℹ️  AI文本生成功能已禁用 (或当前服务商已禁用)');
        return null;
    }

    if (!configLoader.isGeminiConfigured()) {
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

    const maxRetries = 3;
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            // 检查输入文件
            if (!fs.existsSync(highlightPath)) {
                throw new Error(`AI_HIGHLIGHT文件不存在: ${highlightPath}`);
            }

            // 读取内容
            const highlightContent = readHighlightFile(highlightPath);
            if (!highlightContent || highlightContent.trim().length < 10) {
                 console.log(`⚠️  AI_HIGHLIGHT内容过短 (${highlightContent?.length || 0} 字符)，跳过AI生成`);
                 return null;
            }
            console.log(`📖 读取内容完成 (${highlightContent.length} 字符)`);

            // 构建提示词（优先使用传入的 roomId，其次从文件名提取）
            const finalRoomId = roomId || extractRoomIdFromFilename(path.basename(highlightPath));
            // 构建提示词
            const prompt = buildPrompt(highlightContent, finalRoomId);

            // 调用API生成文本
            let generatedText;
            const provider = config.ai?.text?.provider || 'gemini';

            if (provider === 'tuZi') {
                generatedText = await generateTextWithTuZi(prompt);
            } else {
                // 默认使用 Gemini
                generatedText = await generateTextWithGemini(prompt);
            }

            if (!generatedText || generatedText.trim().length < 20) {
                throw new Error(generatedText ? '生成的文本过短' : '生成的文本为空');
            }

            // 确定输出路径
            const dir = path.dirname(highlightPath);
            const baseName = path.basename(highlightPath, '_AI_HIGHLIGHT.txt');
            const outputPath = path.join(dir, `${baseName}_晚安回复.md`);

            // 保存结果
            return saveGeneratedText(outputPath, generatedText, highlightPath);

        } catch (error) {
            lastError = error;
            console.error(`❌ 生成晚安回复失败 (第 ${attempt}/${maxRetries} 次尝试): ${error.message}`);
            
            if (attempt < maxRetries) {
                const waitTime = 2000 * attempt;
                console.log(`⏳ 等待 ${waitTime/1000} 秒后重试...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }
        }
    }

    console.error(`❌ 在 ${maxRetries} 次重试后仍然失败: ${lastError.message}`);
    return null;
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
