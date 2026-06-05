const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');
const configLoader = require('./config-loader');

const GENERATION_LOCK_TIMEOUT_MS = 30 * 60 * 1000;
const GENERATION_LOCK_WAIT_MS = 10 * 60 * 1000;
const GENERATION_LOCK_POLL_MS = 2000;

// 生成不重复的文件名(如果文件已存在,添加 _1, _2 等后缀)
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
            console.warn(`⚠️  删除生成锁失败: ${error.message}`);
        }
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

// 从文件名提取房间ID(如 26966466_...)
function extractRoomIdFromFilename(filename) {
    const m = filename.match(/^(\d+)_/);
    return m ? m[1] : null;
}

// 从文件名提取录制开始时间（格式：录制-ROOMID-YYYYMMDD-HHMMSS-...）
function extractRecordTime(filename) {
    // 严格要求 20YYMMDD-HHMMSS 格式，避免误匹配 roomId
    const m = String(filename || '').match(/20\d{2}(\d{2})(\d{2})-(\d{2})(\d{2})\d{2}/);
    if (!m) return null;
    return { year: 2000 + (+m[0].substring(2,4)), month: +m[1], day: +m[2], hour: +m[3], minute: +m[4] };
}

function getTimeSlotDesc(hour) {
    if (hour >= 5 && hour < 11) return '早安';
    if (hour >= 11 && hour < 14) return '午安';
    if (hour >= 14 && hour < 18) return '下午好';
    return '晚安';
}

// 构建提示词(支持传入 roomId 以使用房间级名称覆盖)
function buildPrompt(highlightContent, roomId, recordTime = null) {
    const names = configLoader.getNames(roomId);
    const anchor = names.anchor;
    const fan = names.fan;
    const wordLimit = configLoader.getWordLimit(roomId);
    const minLengthHint = Math.min(wordLimit, Math.max(80, Math.floor(wordLimit * 0.35)));

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

    // --- 核心修改:全肯定萌萌人 2.0 ---

    // 定义几种不同的"夸奖角度",防止每天都只会说"含金量"
    const praiseAngles = [
        '角度A(心疼路线):侧重于觉得主播今天很辛苦/很努力,表达关心和陪伴。',
        '角度B(爆笑路线):侧重于觉得今天节目效果太好了,全是梗,笑得肚子疼。',
        '角度C(细节路线):侧重于捕捉主播无意间的一个可爱小动作或一句话进行"过度解读"和夸奖。',
        '角度D(崇拜路线):侧重于夸赞主播的歌力/游戏技术/杂谈能力,带有粉丝滤镜的彩虹屁。'
    ];
    const randomAngle = praiseAngles[Math.floor(Math.random() * praiseAngles.length)];

    const mainPrompts = [`性格:
1. **全肯定**:自带800米厚的粉丝滤镜,主播干啥都觉得可爱/厉害。
2. **宠溺**:语气要软,要有亲切感,把主播当成家里人或特别亲近的朋友。
3. **萌萌人**:可以使用颜文字 (  ́∀\`),语气词(捏、呀、嘛、呜呜),但要自然点。

【当前任务】
根据提供的直播内容,写一段晚安回复。
**今日夸奖切入点**:${randomAngle}

【写作要求】
1. **拒绝机械感**:不要像写总结报告一样列123点。要像在发朋友圈或发弹幕一样,把几个亮点揉在一起说。
2. **要有画面感**:如果文档里提到了具体的梗,一定要提一句,证明你真的看了。
3. **情感浓度**:虽然禁止了某些词,但"喜欢"和"支持"的情绪要给足。如果主播今天很累,就多安慰;如果很开心,就跟着一起傻乐。
`,
`

性格:喜欢调侃、宠溺主播,有点话痨,对主播的生活琐事和梗如数家珍。

语气:亲昵、幽默、像老朋友一样聊天。常用语气词(如:哈哈、捏、嘛、呜呜),会使用直播间弹幕黑话。

【核心原则(最重要!)】

严格限定素材:只根据用户当前提供的文档/文本内容进行创作。绝对禁止混入该文档以外的任何已知信息、历史直播内容或互联网搜索结果(因为${anchor}的梗很多,AI容易串台,这一点必须强调)。

时效性:${recordTime ? `该直播录制于 ${recordTime.hour}:${String(recordTime.minute).padStart(2,'0')}，应使用"${getTimeSlotDesc(recordTime.hour)}"作为开场白。` : '根据文档内容判断是早播、午播还是晚播,分别对应"早安"、"午安"或"晚安"的场景。'}

【写作结构与要素】

开场白:
格式:晚安/早安xx(用昵称)!🌙/☀️
内容:一句话总结今天直播的整体感受(如:含金量极高、含梗量爆炸、辛苦了、被治愈了等)。

正文(核心内容回顾):
抓细节:从文档中提取3-5个具体的直播亮点。
生活碎碎念(如:洗碗、吃东西、身体不舒服、猫咪的趣事)。
直播事故/趣事(如:迟到理由、设备故障、口误、奇怪的脑洞)。
鉴赏/游戏环节(如:看了什么电影/视频、玩了什么游戏,主播的反应和吐槽)。
歌回:提到了哪些歌,唱得怎么样(好听/糊弄/搞笑)。
互动吐槽:针对上述细节进行粉丝视角的吐槽或夸奖(如:"只有你能干出这事"、"心疼小笨蛋"、"笑死我了")。

结尾(情感升华):
关怀:叮嘱主播注意身体(嗓子、睡眠、吃饭),不要太累。
期待:确认下一次直播的时间(如果文档里提到了)。`
];

    const randomMainPrompt = mainPrompts[Math.floor(Math.random() * mainPrompts.length)];

    const result = `【角色设定】
身份:${anchor}的铁粉(自称"${fan}")。

${randomMainPrompt}

【字数与格式(必须严格遵守!)】
字数限制:${wordLimit}字以内。这是硬性要求,超过会被系统拒绝!
建议长度:至少 ${minLengthHint} 字,不能只写一句话、不能只写一个问句。
格式:一段完整的自然文字回复,适合手机阅读。不要使用markdown格式,不要使用加粗、标题、列表等。
禁止输出思考过程:直接输出最终的回复内容,不要输出任何分析、推理、计划等中间过程。

【直播内容(主播语音转写+观众弹幕)】
${highlightContent}

请根据直播内容,以${fan}的身份写一篇${recordTime ? getTimeSlotDesc(recordTime.hour) : '晚安'}回复。记住:只使用提供的直播内容,不要添加任何外部信息。直接输出回复内容,不要输出任何其他内容。`;

    console.log('晚安动态prompt主要内容:', randomMainPrompt.substring(0, 100), '直播内容长度:', highlightContent.length);
    return result;
}

function countSentences(text) {
    return text
        .split(/[。!?!?]\s*/u)
        .map(part => part.trim())
        .filter(Boolean).length;
}

function getMinimumReplyLength(wordLimit) {
    if (wordLimit >= 600) return 120;
    if (wordLimit >= 400) return 100;
    if (wordLimit >= 250) return 80;
    if (wordLimit >= 150) return 60;
    return 20;
}

function cleanGeneratedReply(text) {
    let cleaned = text.trim();

    // 移除 Gemini thinking/reasoning 输出(常见格式)
    // 匹配 **xxx** 标题块 + 下面的内容(思考过程)
    cleaned = cleaned.replace(/\*\*[A-Z][a-zA-Z\s]+\*\*\n*[\s\S]*?(?=\n\n晚安|\n\n早安|\n\n午安|\n\n[^\*])/gi, '');

    // 移除 <details>...</details> 标签及内容
    cleaned = cleaned.replace(/<details[\s\S]*?<\/details>/gi, '');

    // 移除 <think...</think 或 <thinking>...</thinking> 标签
    cleaned = cleaned.replace(/<think[\s\S]*?<\/think>/gi, '');
    cleaned = cleaned.replace(/<thinking[\s\S]*?<\/thinking>/gi, '');

    // 移除 ```thinking...``` 代码块
    cleaned = cleaned.replace(/```thinking[\s\S]*?```/gi, '');

    // 移除以 ** 开头的思考步骤标题(如 "**Defining the Parameters**")
    cleaned = cleaned.replace(/^\*\*[A-Z][a-zA-Z\s]+\*\*\s*$/gim, '');

    // 移除 "I've ..." 开头的英文思考句子
    cleaned = cleaned.replace(/^(?:I've |I |Let me |First, |Now, |The |This ).+$/gim, '');

    // 移除模型偶发输出的 Markdown 引用/标题/字数统计,避免直接发到评论区。
    cleaned = cleaned.replace(/^\s*>+\s*(?:🔍\s*)?$/gmu, '');
    cleaned = cleaned.replace(/^\s*>+\s*/gmu, '');
    cleaned = cleaned.replace(/^\s*🔍\s*\*\*[^*\r\n]{2,30}\*\*/gmu, '');
    cleaned = cleaned.replace(/^\s*🔍\s*/gmu, '');
    cleaned = cleaned.replace(/\*\*([^*\r\n]+)\*\*/g, '$1');
    cleaned = cleaned.replace(/^\s{0,3}#{1,6}\s+/gmu, '');
    cleaned = cleaned.replace(/^\s*[((]\s*共\s*\d+\s*字\s*[))]\s*$/gmu, '');
    cleaned = cleaned.replace(/[((]\s*共\s*\d+\s*字\s*[))]\s*$/u, '');

    // 移除连续空行
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

    return cleaned.trim();
}

function validateGeneratedReply(text, wordLimit) {
    // 先清理思考过程
    const inspection = inspectGeneratedReply(text, wordLimit);
    if (!inspection.ok) {
        throw new Error(inspection.reason);
    }

    // 硬性截断保护:B站评论最多1000字
    const bilibiliMaxChars = 1000;
    let cleaned = inspection.cleaned;
    if (cleaned.length > bilibiliMaxChars) {
        console.warn(`⚠️  生成文本超长(${cleaned.length}字),截断到${bilibiliMaxChars}字`);
        // 尝试在句号处截断
        const truncated = cleaned.substring(0, bilibiliMaxChars);
        const lastSentence = Math.max(
            truncated.lastIndexOf('。'),
            truncated.lastIndexOf('!'),
            truncated.lastIndexOf('?'),
            truncated.lastIndexOf('.')
        );
        if (lastSentence > bilibiliMaxChars * 0.5) {
            cleaned = truncated.substring(0, lastSentence + 1);
        } else {
            cleaned = truncated;
        }
    }

    // 按配置的 wordLimit 二次截断(保留一些余量,因为字数限制通常指字符数)
    if (cleaned.length > wordLimit * 1.5) {
        console.warn(`⚠️  生成文本超过wordLimit的1.5倍(${cleaned.length}字 > ${wordLimit * 1.5}),截断`);
        const truncated = cleaned.substring(0, wordLimit);
        const lastSentence = Math.max(
            truncated.lastIndexOf('。'),
            truncated.lastIndexOf('!'),
            truncated.lastIndexOf('?')
        );
        if (lastSentence > wordLimit * 0.5) {
            cleaned = truncated.substring(0, lastSentence + 1);
        } else {
            cleaned = truncated;
        }
    }

    return cleaned;
}

function inspectGeneratedReply(text, wordLimit) {
    const cleaned = cleanGeneratedReply(text);
    const minLength = getMinimumReplyLength(wordLimit);
    const sentenceCount = countSentences(cleaned);

    if (!cleaned) {
        return {
            ok: false,
            reason: '生成的文本为空',
            cleaned,
            minLength,
            sentenceCount
        };
    }

    if (cleaned.length < minLength) {
        return {
            ok: false,
            reason: `生成的文本过短(${cleaned.length} < ${minLength})`,
            cleaned,
            minLength,
            sentenceCount
        };
    }

    if (wordLimit >= 250 && sentenceCount < 2) {
        return {
            ok: false,
            reason: `生成的文本句子数过少(${sentenceCount} < 2)`,
            cleaned,
            minLength,
            sentenceCount
        };
    }

    return {
        ok: true,
        cleaned,
        minLength,
        sentenceCount
    };
}

function createGenerationResult(text, meta) {
    return {
        text: text.trim(),
        meta: {
            provider: meta.provider || 'unknown',
            model: meta.model || 'unknown',
            fallback: Boolean(meta.fallback),
            attempts: meta.attempts || []
        }
    };
}

function isUnsafeGeneratedReply(text) {
    const unsafePatterns = [
        /I'm Claude/i,
        /Anthropic/i,
        /I (?:can't|cannot) (?:complete|comply|help|assist)/i,
        /我不能(?:完成|协助|帮助|满足)/,
        /无法(?:完成|协助|满足)这个请求/,
        /作为(?:一个)?AI(?:语言)?模型/,
        /系统提示/,
        /system prompt/i
    ];

    return unsafePatterns.some(pattern => pattern.test(text));
}

function normalizeTuZiTextMaxTokens(model, configuredMaxTokens, wordLimit = 100) {
    const requested = Number.isFinite(Number(configuredMaxTokens))
        ? Math.max(1, Math.floor(Number(configuredMaxTokens)))
        : Math.max(800, Math.ceil(Number(wordLimit || 100) * 4));
    const modelName = String(model || '').toLowerCase();
    const upstreamLimit = modelName.includes('gemini') ? 65536 : 100000;
    return Math.min(requested, upstreamLimit);
}

function getTuZiFinishReason(choice) {
    return choice?.finish_reason || choice?.finishReason || choice?.native_finish_reason || null;
}

// 调用tuZi API生成文本(备用方案)
async function generateTextWithTuZi(prompt, options = {}) {
    const config = configLoader.getConfig();
    // 优先使用 ai.text.tuZi 配置(文本生成专用),其次使用 ai.comic.tuZi(兼容旧配置)
    const tuziConfig = config.ai?.text?.tuZi || config.aiServices?.tuZi || {};

    if (!configLoader.isTuZiConfigured()) {
        throw new Error('tuZi API未配置,请检查secrets.json中的apiKey');
    }

    console.log('🤖 调用tuZi API生成文本...');

    const configuredFallbackModels = Array.isArray(tuziConfig.fallbackModels)
        ? tuziConfig.fallbackModels
        : [];
    const modelSequence = [
        tuziConfig.model || 'gpt-5.4-mini',
        ...configuredFallbackModels,
        'gemini-3-flash-preview',
        'o4-mini',
        'qwen2.5-72b-instruct',
        'grok-4.1'
    ].filter((model, index, models) => model && models.indexOf(model) === index);
    const baseUrl = tuziConfig.baseUrl || 'https://api.tu-zi.com';
    const apiUrl = `${baseUrl}/v1/chat/completions`;
    const attempts = Array.isArray(options.attempts) ? [...options.attempts] : [];
    const fallbackFromPrimary = Boolean(options.fallback);
    const wordLimit = Number(options.wordLimit || configLoader.getByPath('ai.defaultWordLimit', 100));

    // 设置代理
    let agent = null;
    if (tuziConfig.proxy) {
        console.log(`   使用代理: ${tuziConfig.proxy}`);
        agent = new HttpsProxyAgent(tuziConfig.proxy);
    }

    // 重试逻辑
    for (let attempt = 0; attempt < modelSequence.length; attempt++) {
        const textModel = modelSequence[attempt];
        try {
            console.log(`[WAIT] 正在通过tu-zi.com API生成文本... (尝试 ${attempt + 1}/${modelSequence.length} model: ${textModel}, 超时: 60s)`);

            // 获取超时时间 (默认 60 秒)
            const timeoutMs = config.timeouts?.aiApiTimeout || 60000;
            const effectiveMaxTokens = normalizeTuZiTextMaxTokens(textModel, tuziConfig.maxTokens, wordLimit);
            console.log(`   max_tokens: ${effectiveMaxTokens} (configured=${tuziConfig.maxTokens || 'default'}, wordLimit=${wordLimit})`);

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
                    max_tokens: effectiveMaxTokens
                }),
                agent: agent,
                timeout: timeoutMs
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`tuZi API返回错误 ${response.status}: ${errorText}`);
            }

            const data = await response.json();
            const choice = data.choices?.[0];
            const finishReason = getTuZiFinishReason(choice);
            const usage = data.usage || null;
            const text = choice?.message?.content;
            console.log(`   finish_reason: ${finishReason || 'unknown'}, usage: ${usage ? JSON.stringify(usage) : 'unknown'}`);

            if (!text || text.trim().length === 0) {
                throw new Error('tuZi API返回空结果');
            }

            if (finishReason && ['length', 'max_tokens', 'MAX_TOKENS'].includes(String(finishReason))) {
                throw new Error(`tuZi API输出达到长度上限,疑似被截断 (finish_reason=${finishReason}, max_tokens=${effectiveMaxTokens})`);
            }

            if (isUnsafeGeneratedReply(text)) {
                throw new Error('tuZi API返回疑似拒绝/身份自述内容,跳过该模型');
            }

            attempts.push({
                provider: 'tuZi',
                model: textModel,
                status: 'success',
                finishReason: finishReason || 'unknown',
                completionTokens: usage?.completion_tokens ?? usage?.completionTokens,
                totalTokens: usage?.total_tokens ?? usage?.totalTokens,
                maxTokens: effectiveMaxTokens
            });
            console.log('✅ tuZi API调用成功');
            return createGenerationResult(text, {
                provider: 'tuZi',
                model: textModel,
                fallback: fallbackFromPrimary || attempt > 0,
                attempts,
                finishReason: finishReason || 'unknown',
                usage,
                maxTokens: effectiveMaxTokens
            });
        } catch (error) {
            attempts.push({
                provider: 'tuZi',
                model: textModel,
                status: 'failure',
                error: String(error.message || error).slice(0, 300)
            });
            console.error(`❌ tuZi API调用失败 (尝试 ${attempt + 1}/${modelSequence.length}): ${error.message}`);

            // 如果是最后一次尝试,抛出错误
            if (attempt === modelSequence.length - 1) {
                throw error;
            }

            // 等待一小段时间后重试
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}

// 调用Gemini API生成文本
async function generateTextWithGemini(prompt, options = {}) {
    const config = configLoader.getConfig();
    const geminiConfig = config.aiServices?.gemini || config.ai?.text?.gemini || {};

    if (!configLoader.isGeminiConfigured()) {
        throw new Error('Gemini API未配置,请检查secrets.json中的apiKey');
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
        // SDK 不支持在构造函数传 agent,我们需要劫持全局 fetch 来注入代理
        if (geminiConfig.proxy) {
            console.log(`   使用代理: ${geminiConfig.proxy}`);
            const agent = new HttpsProxyAgent(geminiConfig.proxy);

            // 临时覆盖全局 fetch,强制让 SDK 走 node-fetch 并带上 agent 和 timeout
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

        // 使用 Promise.race 实现外部超时控制,双重保障
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

        if (isUnsafeGeneratedReply(text)) {
            throw new Error('Gemini API返回疑似拒绝/身份自述内容');
        }

        // 恢复原始 fetch(如果被覆盖了)
        if (originalFetch !== null) {
            global.fetch = originalFetch;
        }

        console.log('✅ Gemini API调用成功');
        return createGenerationResult(text, {
            provider: 'gemini',
            model: geminiConfig.model,
            fallback: false,
            attempts: [{ provider: 'gemini', model: geminiConfig.model, status: 'success' }]
        });
    } catch (error) {
        // 恢复原始 fetch(如果被覆盖了)
        if (originalFetch !== null) {
            global.fetch = originalFetch;
        }

        // 不管什么 Gemini 错误,都尝试使用 tuZi API 重试
        if (configLoader.isTuZiConfigured()) {
            console.warn(`⚠️  Gemini API调用失败 (${error.message}),尝试使用tuZi API作为备用方案...`);
            try {
                return await generateTextWithTuZi(prompt, {
                    fallback: true,
                    wordLimit: options.wordLimit,
                    attempts: [{
                        provider: 'gemini',
                        model: geminiConfig.model || 'unknown',
                        status: 'failure',
                        error: String(error.message || error).slice(0, 300)
                    }]
                });
            } catch (tuziError) {
                console.error(`❌ tuZi API备用方案也失败: ${tuziError.message}`);
                throw new Error(`Gemini和tuZi API都失败: Gemini - ${error.message}, tuZi - ${tuziError.message}`);
            }
        }

        console.error(`❌ Gemini API调用失败: ${error.message}`);
        throw error;
    }
}

function yamlQuote(value) {
    return JSON.stringify(String(value ?? ''));
}

function buildTextFrontMatter(highlightPath, generationMeta = {}) {
    const attempts = Array.isArray(generationMeta.attempts) ? generationMeta.attempts : [];
    const lines = [
        '---',
        `generatedAt: ${yamlQuote(new Date().toISOString())}`,
        `sourceHighlight: ${yamlQuote(path.basename(highlightPath))}`,
        `provider: ${yamlQuote(generationMeta.provider || 'unknown')}`,
        `model: ${yamlQuote(generationMeta.model || 'unknown')}`,
        `fallback: ${generationMeta.fallback ? 'true' : 'false'}`,
        'attempts:'
    ];

    if (attempts.length === 0) {
        lines.push('  []');
    } else {
        for (const attempt of attempts) {
            lines.push(`  - provider: ${yamlQuote(attempt.provider || 'unknown')}`);
            lines.push(`    model: ${yamlQuote(attempt.model || 'unknown')}`);
            lines.push(`    status: ${yamlQuote(attempt.status || 'unknown')}`);
            if (attempt.finishReason) {
                lines.push(`    finishReason: ${yamlQuote(attempt.finishReason)}`);
            }
            if (attempt.maxTokens !== undefined) {
                lines.push(`    maxTokens: ${Number(attempt.maxTokens)}`);
            }
            if (attempt.completionTokens !== undefined) {
                lines.push(`    completionTokens: ${Number(attempt.completionTokens)}`);
            }
            if (attempt.totalTokens !== undefined) {
                lines.push(`    totalTokens: ${Number(attempt.totalTokens)}`);
            }
            if (attempt.error) {
                lines.push(`    error: ${yamlQuote(attempt.error)}`);
            }
        }
    }

    if (generationMeta.finishReason) {
        lines.push(`finishReason: ${yamlQuote(generationMeta.finishReason)}`);
    }
    if (generationMeta.maxTokens !== undefined) {
        lines.push(`maxTokens: ${Number(generationMeta.maxTokens)}`);
    }

    lines.push('---', '');
    return lines.join('\n');
}

// 保存生成的文本
function saveGeneratedText(outputPath, text, highlightPath, generationMeta = {}) {
    try {
        // 生成不重复的文件名
        const uniquePath = generateUniqueFilename(outputPath);

        // 添加元信息
        const metaInfo = buildTextFrontMatter(highlightPath, generationMeta);

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
    const dir = path.dirname(highlightPath);
    const baseName = path.basename(highlightPath, '_AI_HIGHLIGHT.txt');
    const outputPath = path.join(dir, `${baseName}_晚安回复.md`);
    const lockPath = `${outputPath}.lock`;
    const existingOutput = getExistingGeneratedFile(outputPath);

    if (existingOutput) {
        console.log(`i️  晚安回复已存在,跳过重复生成: ${path.basename(existingOutput)}`);
        return existingOutput;
    }

    const lockAcquired = acquireGenerationLock(lockPath);
    if (!lockAcquired) {
        console.log(`⏳ 晚安回复正在由其他进程生成,等待结果: ${path.basename(outputPath)}`);
        const generatedByOtherProcess = await waitForGeneratedFile(outputPath, lockPath);
        if (generatedByOtherProcess) {
            console.log(`✅ 复用其他进程生成的晚安回复: ${path.basename(generatedByOtherProcess)}`);
            return generatedByOtherProcess;
        }

        console.log('⚠️  等待晚安回复生成超时,跳过本次重复生成');
        return null;
    }

    try {
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
            console.log('i️  AI文本生成功能已禁用 (或当前服务商已禁用)');
            return null;
        }

        if (!configLoader.isGeminiConfigured()) {
            console.log('⚠️  Gemini API未配置,使用本地回退生成晚安回复');

            // 本地回退:简单根据文本摘取亮点并生成一段固定模板的晚安回复,便于无API时验证流程
            try {
                const highlightContent = readHighlightFile(highlightPath);
                const lines = highlightContent.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
                const picks = lines.slice(0, 5).map((l, i) => `${i+1}. ${l}`);
                const fallback = `# 晚安(本地回退)\n\n今天的直播亮点:\n${picks.join('\n')}\n\n谢谢今天的陪伴,晚安~`;
                return saveGeneratedText(outputPath, fallback, highlightPath, {
                    provider: 'local',
                    model: 'local-template',
                    fallback: true,
                    attempts: [{ provider: 'local', model: 'local-template', status: 'success' }]
                });
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
                 console.log(`⚠️  AI_HIGHLIGHT内容过短 (${highlightContent?.length || 0} 字符),跳过AI生成`);
                 return null;
            }
            console.log(`📖 读取内容完成 (${highlightContent.length} 字符)`);

            // 构建提示词(优先使用传入的 roomId,其次从文件名提取)
            const finalRoomId = roomId || extractRoomIdFromFilename(path.basename(highlightPath));
            const recordTime = extractRecordTime(path.basename(highlightPath));
            // 构建提示词
            const prompt = buildPrompt(highlightContent, finalRoomId, recordTime);
            const wordLimit = configLoader.getWordLimit(finalRoomId);

            // 调用API生成文本
            let generationResult;
            const provider = config.ai?.text?.provider || 'gemini';

            if (provider === 'tuZi') {
                generationResult = await generateTextWithTuZi(prompt, { wordLimit });
            } else {
                // 默认使用 Gemini
                generationResult = await generateTextWithGemini(prompt, { wordLimit });
            }

            const rawGeneratedText = generationResult.text;
            const inspection = inspectGeneratedReply(rawGeneratedText, wordLimit);
            if (!inspection.ok) {
                if (String(rawGeneratedText || '').trim()) {
                    saveFailedGeneratedText(outputPath, rawGeneratedText, highlightPath, generationResult.meta, {
                        attempt,
                        maxRetries,
                        reason: inspection.reason,
                        rawLength: String(rawGeneratedText).length,
                        cleanedLength: inspection.cleaned.length
                    });
                }
                throw new Error(inspection.reason);
            }

            const generatedText = validateGeneratedReply(rawGeneratedText, wordLimit);
            console.log(`✅ 文本长度校验通过: ${generatedText.length} 字符 (wordLimit=${wordLimit})`);

            // 确定输出路径
            // 保存结果
            return saveGeneratedText(outputPath, generatedText, highlightPath, generationResult.meta);

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
    } finally {
        releaseGenerationLock(lockPath);
    }
}

function cleanShortTitle(text, fallback) {
    const cleaned = String(text || '')
        .trim()
        .replace(/^["""'']+|["""'']+$/g, '')
        .replace(/^标题[::]\s*/u, '')
        .replace(/\s+/g, ' ');
    if (!cleaned || cleaned.length > 60 || /\n/.test(cleaned)) {
        return fallback;
    }
    return cleaned;
}

async function generateClipTitle(context = {}) {
    const fallback = context.defaultTitle || '提到岁己的小片段';
    const config = configLoader.getConfig();
    const textEnabled = config.ai?.text?.enabled !== false;
    if (!textEnabled) {
        return fallback;
    }

    const preCtx = context.preContext || '';
    const postCtx = context.postContext || '';
    const fullCtx = context.fullClipText || context.sampleText || '';

    const prompt = [
        '给一个B站直播切片生成短标题。',
        '要求：',
        '1. 只输出标题本身，不要解释，不要引号，不要以"【"开头。',
        '2. 30字以内，适合B站投稿标题。',
        '3. 准确描述切片中主播说了什么/做了什么，不要编造。',
        '4. 要结合上下文理解字幕——ASR可能有同音错字，要根据语境推断正确意思。',
        '5. 如果提到特定主播名字，直接用名字（岁己/小岁/栞栞/米米等），不要加引号。',
        '',
        `主播: ${context.streamerName || '主播'}`,
        `原直播标题: ${context.streamTitle || '未知'}`,
        `录制时间: ${context.recordedAt || '未知'}`,
        `片段时间: ${context.startTime || ''}-${context.endTime || ''}`,
        '',
        '=== 切片之前的上下文（帮助理解前因） ===',
        (preCtx || '（无）').slice(0, 600),
        '',
        '=== 切片字幕内容 ===',
        fullCtx.slice(0, 800),
        '',
        '=== 切片之后的上下文（帮助理解后续） ===',
        (postCtx || '（无）').slice(0, 600),
    ].join('\n');

    try {
        const provider = config.ai?.text?.provider || 'gemini';
        const result = provider === 'tuZi'
            ? await generateTextWithTuZi(prompt, { wordLimit: 80 })
            : await generateTextWithGemini(prompt, { wordLimit: 80 });
        return cleanShortTitle(result.text, fallback);
    } catch (error) {
        console.warn(`⚠️  AI切片标题生成失败，使用模板标题: ${error.message}`);
        return fallback;
    }
}

async function generateClipDescription(context = {}) {
    const config = configLoader.getConfig();
    const textEnabled = config.ai?.text?.enabled !== false;
    if (!textEnabled) {
        return null;
    }

    const preCtx = context.preContext || '';
    const postCtx = context.postContext || '';
    const fullCtx = context.fullClipText || context.sampleText || '';

    const prompt = [
        '给一个B站直播切片写一句简介（50字以内）。',
        '要求：',
        '1. 只输出简介文字，不要解释，不要引号。',
        '2. 一句话说清楚主播在聊什么、发生了什么。',
        '3. 准确基于上下文，ASR可能有同音错字要根据语境推断。',
        '4. 风格自然口语化，不要广告语气。',
        '5. 如果提到其他主播（如岁己/小岁/栞栞），直接用名字。',
        '',
        `主播: ${context.streamerName || '主播'}`,
        '',
        '=== 前因 ===',
        (preCtx || '（无）').slice(0, 400),
        '',
        '=== 切片内容 ===',
        fullCtx.slice(0, 600),
        '',
        '=== 后续 ===',
        (postCtx || '（无）').slice(0, 400),
    ].join('\n');

    try {
        const provider = config.ai?.text?.provider || 'gemini';
        const result = provider === 'tuZi'
            ? await generateTextWithTuZi(prompt, { wordLimit: 80 })
            : await generateTextWithGemini(prompt, { wordLimit: 80 });
        const text = (result.text || '').trim();
        if (text && text.length > 5 && text.length < 100) {
            return text;
        }
        return null;
    } catch (error) {
        console.warn(`⚠️  AI切片简介生成失败: ${error.message}`);
        return null;
    }
}

function saveFailedGeneratedText(outputPath, text, highlightPath, generationMeta = {}, attemptInfo = {}) {
    try {
        const basePath = outputPath.replace(/_晚安回复\.md$/i, '');
        const safeReason = String(attemptInfo.reason || 'unknown')
            .replace(/[\\/:*?"<>|]/g, '_')
            .slice(0, 24);
        const debugPath = generateUniqueFilename(`${basePath}_晚安回复_ATTEMPT${attemptInfo.attempt || 0}_${safeReason}.md`);
        const highlightName = path.basename(highlightPath);
        const metaInfo = [
            `# 晚安回复诊断稿(未通过校验)`,
            `基于: ${highlightName}`,
            `尝试: ${attemptInfo.attempt || 0}/${attemptInfo.maxRetries || 0}`,
            `失败原因: ${attemptInfo.reason || 'unknown'}`,
            `原始字符数: ${String(attemptInfo.rawLength ?? String(text || '').length)}`,
            `清理后字符数: ${String(attemptInfo.cleanedLength ?? 0)}`,
            `生成时间: ${new Date().toLocaleString('zh-CN')}`,
            `---`,
            ``
        ].join('\n');
        fs.writeFileSync(debugPath, `${metaInfo}${String(text || '')}`, 'utf8');
        console.log(`🧪 诊断稿已保存: ${path.basename(debugPath)}`);
        return debugPath;
    } catch (error) {
        console.warn(`⚠️ 保存诊断稿失败: ${error.message}`);
        return null;
    }
}

// 批量处理目录中的所有AI_HIGHLIGHT文件
async function batchGenerateGoodnightReplies(directory) {
    try {
        const files = fs.readdirSync(directory);
        const highlightFiles = files.filter(f => f.endsWith('_AI_HIGHLIGHT.txt'));

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
    generateClipTitle,
    generateClipDescription,
    generateTextWithGemini,
    generateTextWithTuZi,
    batchGenerateGoodnightReplies
};

// 命令行测试
if (require.main === module) {
    const args = process.argv.slice(2);

    if (args.length === 0) {
        console.log('用法:');
        console.log('  1. 处理单个文件: node ai_text_generator.js <AI_HIGHLIGHT.txt路径> [--room-id <房间ID>]');
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
                process.stdout.write(generated.text + '\n');
            } else {
                const roomIdArgIndex = args.indexOf('--room-id');
                const roomId = roomIdArgIndex >= 0 ? args[roomIdArgIndex + 1] : null;
                const result = await generateGoodnightReply(args[0], roomId);
                if (result) {
                    console.log(`\n🎉 处理完成,输出文件: ${result}`);
                } else {
                    console.log('\ni️  未生成任何文件');
                }
            }
        } catch (error) {
            console.error(`💥 处理失败: ${error.message}`);
            process.exit(1);
        }
    })();
}
