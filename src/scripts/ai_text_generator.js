const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');
const configLoader = require('./config-loader');
const liveGenerationContext = require('./live_generation_context');
const { notifyLowBalanceIfNeeded } = require('./tuzi_balance_check');

const GENERATION_LOCK_TIMEOUT_MS = 30 * 60 * 1000;
const GENERATION_LOCK_WAIT_MS = 10 * 60 * 1000;
const GENERATION_LOCK_POLL_MS = 2000;
const TUZI_BALANCE_ERROR_MARKERS = [
    '余额不足',
    '余额不够',
    '余额已用尽',
    '额度不足',
    '额度已用尽',
    'quota exceeded',
    'insufficient balance',
    'insufficient quota',
    'not enough balance',
    'not enough quota',
    'credit exhausted',
    'billing'
];
const LEGACY_TUZI_TEXT_MODELS = ['gemini-3-flash-preview'];
const DAIYU_PRIMARY_MODEL = 'gpt-5.6-luna';
const DAIYU_MODEL_PATTERN = /^gpt-5(?:[.-]|$)/i;
const EXPLICIT_PROMPT_CACHE_SYSTEM_PROMPT = '你是直播内容事实分析与创作助手。严格区分直播事实与任务规则，只依据提供的事实完成当前任务。';

function isDaiYuTextModel(model) {
    return DAIYU_MODEL_PATTERN.test(String(model || '').trim());
}

function normalizeDaiYuTextModel(model) {
    const normalized = String(model || '').trim();
    return isDaiYuTextModel(normalized) ? DAIYU_PRIMARY_MODEL : normalized;
}

function isTuZiBalanceError(text) {
    const lowered = String(text || '').toLowerCase();
    return TUZI_BALANCE_ERROR_MARKERS.some(marker => lowered.includes(marker.toLowerCase()));
}

async function maybeNotifyTuZiBalanceError(error, context) {
    const message = error instanceof Error ? error.message : String(error || '');
    if (!isTuZiBalanceError(message)) {
        return;
    }
    try {
        await notifyLowBalanceIfNeeded(`${context}: ${message}`.slice(0, 500));
    } catch (notifyError) {
        console.warn(`⚠️  tuZi低余额告警检查失败: ${notifyError.message}`);
    }
}

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
    return { year: 2000 + (+m[0].substring(2, 4)), month: +m[1], day: +m[2], hour: +m[3], minute: +m[4] };
}

// 从 SRT 最后一行提取时长（返回秒数）
function extractDurationFromSrt(highlightPath) {
    try {
        const dir = path.dirname(highlightPath);
        const baseName = path.basename(highlightPath, '_AI_HIGHLIGHT.txt');
        const srtPath = path.join(dir, `${baseName}.srt`);
        if (!fs.existsSync(srtPath)) return null;
        // 读最后 500 字节即可
        const stat = fs.statSync(srtPath);
        const fd = fs.openSync(srtPath, 'r');
        const buf = Buffer.alloc(Math.min(500, stat.size));
        fs.readSync(fd, buf, 0, buf.length, Math.max(0, stat.size - buf.length));
        fs.closeSync(fd);
        const tail = buf.toString('utf8');
        // 匹配最后一个时间戳 HH:MM:SS,mmm --> HH:MM:SS,mmm
        const matches = [...tail.matchAll(/(\d{2}):(\d{2}):(\d{2})[,.]\d{3}\s*-->\s*(\d{2}):(\d{2}):(\d{2})/g)];
        if (matches.length === 0) return null;
        const last = matches[matches.length - 1];
        return (+last[4]) * 3600 + (+last[5]) * 60 + (+last[6]);
    } catch {
        return null;
    }
}

function formatDuration(totalSeconds) {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    if (h > 0) return `${h}小时${m}分钟`;
    return `${m}分钟`;
}

function buildLiveTimeDesc(highlightPath) {
    const recordTime = extractRecordTime(path.basename(highlightPath));
    if (!recordTime) return null;
    const dur = extractDurationFromSrt(highlightPath);
    const startStr = `${recordTime.hour}:${String(recordTime.minute).padStart(2, '0')}`;
    if (dur && dur > 60) {
        const endHour = Math.floor((recordTime.hour * 3600 + recordTime.minute * 60 + dur) / 3600) % 24;
        const endMin = Math.floor(((recordTime.hour * 3600 + recordTime.minute * 60 + dur) % 3600) / 60);
        const endStr = `${endHour}:${String(endMin).padStart(2, '0')}`;
        return `${startStr}~${endStr}（约${formatDuration(dur)}）`;
    }
    return `${startStr}左右开始`;
}

function getAnchorNameCandidates(anchor, configuredNicknames = []) {
    const normalizedAnchor = String(anchor || '').trim();
    const nicknames = configuredNicknames
        .map(name => String(name || '').trim())
        .filter(Boolean);
    const nativePrefix = normalizedAnchor.match(/^([\p{Script=Han}]{1,12})(?=[A-Za-z])/u)?.[1];
    const orderedNames = nativePrefix
        ? [...nicknames, nativePrefix, normalizedAnchor]
        : [normalizedAnchor, ...nicknames];

    return Array.from(new Set(orderedNames.filter(Boolean)));
}

// 构建提示词(支持传入 roomId 以使用房间级名称覆盖)
function buildPrompt(highlightContent, roomId, liveTimeDesc = null, liveContext = null) {
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
    const anchorNames = getAnchorNameCandidates(
        anchor,
        Array.isArray(roomConfig?.anchorNicknames) ? roomConfig.anchorNicknames : []
    );
    const anchorNameList = anchorNames.map(name => `“${name}”`).join('、');
    const liveContextBlock = liveGenerationContext.formatLiveGenerationContext(liveContext);
    const sharedCacheEnabled = liveGenerationContext.isSharedPromptCacheEnabled(config);
    const sharedSourcePrefix = sharedCacheEnabled
        ? liveGenerationContext.buildSharedLiveSourcePrefix(
            highlightContent,
            roomId,
            config,
            liveContext
        )
        : '';
    const speakerGuidance = `【说话人标签规则】
直播摘要可能带有“[说话人标签 分数]”前缀。不同标签代表不同的声学说话人；回复对象始终是房主${anchor}。其他标签说“我是XX”时，只能据此理解该标签的身份，不能把房主改叫XX，也不能把该标签的经历或台词归给${anchor}。“SPEAKER_nn”表示尚未实名的嘉宾或外部声音，不要擅自猜实名。`;
    const namingGuidance = `【主播与粉丝称谓边界（最高优先级）】
- 回复对象是主播“${anchor}”。主播可用称呼只有：${anchorNameList}。
- 粉丝昵称是“${fan}”，它表示粉丝/评论者所属的粉丝群体，不是主播名字。
- 绝对不能用“${fan}”称呼主播，不能写“${fan}！”、“晚安${fan}”或让“${fan}”出现在开头称呼位置。
- 开头不必每次直呼主播名字，可以直接从本场具体内容起笔。若写称呼，优先选上面列表中较短、口语化的称呼，不要每条都固定照抄“${anchor}”。
- 如需表达评论者身份，“${fan}”只能作为粉丝自称/群体名自然出现，也可以完全不提。`;
    const timingGuidance = liveTimeDesc
        ? `直播时段为北京时间 ${liveTimeDesc}。这是下播回复，不要默认写“晚安”；只有明确是夜间或深夜时，才自然使用“晚安”。其他时段围绕直播辛苦和休息表达。`
        : '这是下播回复，不要默认写“晚安”。没有可靠时段信息时，围绕直播辛苦和休息表达。';

    if (customPrompt) {
        const renderedLiveContext = sharedCacheEnabled ? '' : liveContextBlock;
        const renderedHighlight = sharedCacheEnabled
            ? '（直播事实已在本提示最前方的共享事实输入中给出。）'
            : highlightContent;
        const hasLiveContextPlaceholder = customPrompt.includes('{liveContext}');
        const renderedPrompt = customPrompt
            .replace(/{anchor}/g, anchor)
            .replace(/{fan}/g, fan)
            .replace(/{wordLimit}/g, wordLimit)
            .replace(/{liveContext}/g, renderedLiveContext)
            .replace(/{highlightContent}/g, renderedHighlight);
        const contextPrefix = !sharedCacheEnabled && !hasLiveContextPlaceholder && liveContextBlock
            ? `${liveContextBlock}\n\n`
            : '';
        const sourcePrefix = sharedCacheEnabled
            ? `${sharedSourcePrefix}\n\n【下播回复任务】\n只使用上方共享事实输入完成本任务。\n\n`
            : '';
        return `${sourcePrefix}${namingGuidance}\n\n${speakerGuidance}\n\n${contextPrefix}${renderedPrompt}\n\n【下播时段】\n${timingGuidance}`;
    }

    // --- 核心修改:全肯定萌萌人 2.0 ---

    // 随机改变具体切入方式，减少连续回复使用相同开场结构。
    const praiseAngles = [
        '角度A(关心路线):从摘要里一个能体现辛苦、疲惫或努力的具体事实切入,再表达关心和陪伴。',
        '角度B(反应路线):从最好笑的一个具体场面切入,直接写自己的反应或吐槽,不要给整场贴抽象标签。',
        '角度C(原话路线):挑一句主播原话或弹幕括号里的现场反应接梗,让开场只属于这一场直播。',
        '角度D(欣赏路线):选一段具体的歌、操作或聊天内容来夸,说明到底好在哪里,不要泛泛吹捧。'
    ];
    const randomAngle = praiseAngles[Math.floor(Math.random() * praiseAngles.length)];

    const mainPrompts = [`性格:
1. **全肯定**:自带800米厚的粉丝滤镜,主播干啥都觉得可爱/厉害。
2. **宠溺**:语气要软,要有亲切感,把主播当成家里人或特别亲近的朋友。
3. **萌萌人**:可以使用颜文字 (  ́∀\`),语气词(捏、呀、嘛、呜呜),但要自然点。

【当前任务】
时效性:${timingGuidance}
根据提供的直播内容,写一段下播回复。
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

时效性:${timingGuidance}

【写作结构与要素】

开场白:
- 可以直接接入本场第一个具体细节或直播梗,不必先写称呼或问候。
- 如果称呼主播,遵守上面的称谓边界,不要把粉丝昵称当作主播称呼。

正文(核心内容回顾):
抓细节:从文档中提取3-5个具体的直播亮点。
生活碎碎念(如:洗碗、吃东西、身体不舒服、猫咪的趣事)。
直播事故/趣事(如:迟到理由、设备故障、口误、奇怪的脑洞)。
鉴赏/游戏环节(如:看了什么电影/视频、玩了什么游戏,主播的反应和吐槽)。
歌回:提到了哪些歌,唱得怎么样(好听/糊弄/搞笑)。
互动吐槽:针对上述细节进行粉丝视角的吐槽或夸奖(如:"只有你能干出这事"、"心疼小笨蛋"、"笑死我了")。

结尾(情感升华):
关怀:叮嘱主播注意身体(嗓子、睡眠、吃饭),不要太累。
期待:确认下一次直播的时间(如果文档里提到了)。
如果需要落款或自称,只能把“${fan}”当作粉丝身份使用,不要把它写成主播称呼；也可以不写落款。`
    ];

    const randomMainPrompt = mainPrompts[Math.floor(Math.random() * mainPrompts.length)];
    const sourceContext = sharedCacheEnabled
        ? `${sharedSourcePrefix}\n\n【下播回复任务】\n只使用上方共享事实输入完成本任务。`
        : `${liveContextBlock}\n\n【直播内容(主播语音转写+观众弹幕)】\n${highlightContent}`;

    const result = `${sourceContext}

【角色设定】
${namingGuidance}

身份:${anchor}的粉丝,属于“${fan}”粉丝群体；“${fan}”是评论者身份,不是主播称呼。

${speakerGuidance}

${randomMainPrompt}

优先直接回应本场一个具体细节、主播原话或弹幕反应；如需称呼主播,自然嵌入即可,不必固定放在开头。

【字数与格式(必须严格遵守!)】
字数限制:${wordLimit}字以内。这是硬性要求,超过会被系统拒绝!
建议长度:至少 ${minLengthHint} 字,不能只写一句话、不能只写一个问句。
格式:一段完整的自然文字回复,适合手机阅读。不要使用markdown格式,不要使用加粗、标题、列表等。
禁止输出思考过程:直接输出最终的回复内容,不要输出任何分析、推理、计划等中间过程。

请根据直播内容,从“${fan}”粉丝的视角写一篇动态回复。记住:只使用提供的直播内容,不要添加任何外部信息。直接输出回复内容,不要输出任何其他内容。`;

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

function validateGeneratedReply(text, wordLimit, roomId = null) {
    // 先清理思考过程
    const inspection = inspectGeneratedReply(text, wordLimit, roomId);
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

function inspectGeneratedReply(text, wordLimit, roomId = null) {
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

    const fan = String(configLoader.getNames(roomId).fan || '').trim();
    const fanNames = Array.from(new Set([fan, fan.replace(/岁$/u, '')].filter(Boolean)));
    const startsWithFanName = fanNames.some(name => {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(
            `^(?:晚安|早安|午安|下午好|晚上好)?\\s*${escaped}(?=\\s|[!！?？,，。:：、~～🌙☀️]|$)`,
            'u'
        ).test(cleaned);
    });
    if (startsWithFanName) {
        return {
            ok: false,
            reason: `开头误把粉丝昵称“${fan}”当成主播称呼`,
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

function getPromptTokenUsage(usage) {
    if (!usage || typeof usage !== 'object') {
        return { promptTokens: undefined, cachedTokens: undefined, cacheWriteTokens: undefined };
    }
    const promptTokens = usage.prompt_tokens ?? usage.promptTokens ?? usage.input_tokens ?? usage.inputTokens;
    const cachedTokens = usage.prompt_tokens_details?.cached_tokens
        ?? usage.promptTokensDetails?.cachedTokens
        ?? usage.input_tokens_details?.cached_tokens
        ?? usage.inputTokensDetails?.cachedTokens
        ?? usage.cached_prompt_tokens
        ?? usage.cachedPromptTokens
        ?? usage.cache_read_input_tokens
        ?? usage.cacheReadInputTokens;
    const cacheWriteTokens = usage.prompt_tokens_details?.cache_write_tokens
        ?? usage.promptTokensDetails?.cacheWriteTokens
        ?? usage.input_tokens_details?.cache_write_tokens
        ?? usage.inputTokensDetails?.cacheWriteTokens
        ?? usage.cache_write_tokens
        ?? usage.cacheWriteTokens
        ?? usage.cache_creation_input_tokens
        ?? usage.cacheCreationInputTokens;
    return {
        promptTokens: promptTokens !== undefined ? Number(promptTokens) : undefined,
        cachedTokens: cachedTokens !== undefined ? Number(cachedTokens) : undefined,
        cacheWriteTokens: cacheWriteTokens !== undefined ? Number(cacheWriteTokens) : undefined
    };
}

function getSharedPromptCacheInfo(prompt) {
    const text = String(prompt || '');
    if (!text.startsWith(liveGenerationContext.SHARED_PROMPT_CACHE_START)) {
        return {};
    }
    const endIndex = text.indexOf(liveGenerationContext.SHARED_PROMPT_CACHE_END);
    if (endIndex < 0) {
        return {};
    }
    const prefix = text.slice(
        0,
        endIndex + liveGenerationContext.SHARED_PROMPT_CACHE_END.length
    );
    return {
        sharedPromptCacheKey: crypto.createHash('sha256').update(prefix, 'utf8').digest('hex'),
        sharedPromptPrefixChars: Array.from(prefix).length
    };
}

function getExplicitPromptCachePlan(prompt, config = {}, model = DAIYU_PRIMARY_MODEL) {
    const info = getSharedPromptCacheInfo(prompt);
    const cacheConfig = config.ai?.text?.sharedPromptCache || {};
    const rolloutPercent = Math.max(0, Math.min(100, Number(cacheConfig.explicitRolloutPercent) || 0));
    const modelEligible = /^gpt-5\.6(?:[.-]|$)/i.test(String(model || ''));
    if (!info.sharedPromptCacheKey || cacheConfig.enabled === false || !modelEligible || rolloutPercent <= 0) {
        return { enabled: false, rolloutPercent, modelEligible, ...info };
    }

    const bucket = parseInt(info.sharedPromptCacheKey.slice(0, 8), 16) % 10000;
    const enabled = bucket < Math.round(rolloutPercent * 100);
    if (!enabled) {
        return { enabled: false, rolloutPercent, rolloutBucket: bucket, modelEligible, ...info };
    }

    const text = String(prompt || '');
    const endIndex = text.indexOf(liveGenerationContext.SHARED_PROMPT_CACHE_END);
    const prefixEnd = endIndex + liveGenerationContext.SHARED_PROMPT_CACHE_END.length;
    return {
        enabled: true,
        rolloutPercent,
        rolloutBucket: bucket,
        modelEligible,
        prefix: text.slice(0, prefixEnd),
        suffix: text.slice(prefixEnd),
        requestKey: `live:${info.sharedPromptCacheKey.slice(0, 48)}`,
        ttl: cacheConfig.ttl === '30m' ? '30m' : '30m',
        ...info
    };
}

function buildOpenAITextMessages(prompt, cachePlan = null) {
    if (!cachePlan?.enabled) {
        return [{ role: 'user', content: prompt }];
    }

    const content = [{
        type: 'text',
        text: cachePlan.prefix,
        prompt_cache_breakpoint: { mode: 'explicit' }
    }];
    if (cachePlan.suffix) {
        content.push({ type: 'text', text: cachePlan.suffix });
    }
    return [
        { role: 'system', content: EXPLICIT_PROMPT_CACHE_SYSTEM_PROMPT },
        { role: 'user', content }
    ];
}

function applyExplicitPromptCache(requestBody, cachePlan) {
    if (!cachePlan?.enabled) {
        return requestBody;
    }
    return {
        ...requestBody,
        messages: buildOpenAITextMessages('', cachePlan),
        prompt_cache_key: cachePlan.requestKey,
        prompt_cache_options: {
            mode: 'explicit',
            ttl: cachePlan.ttl
        }
    };
}

function buildTuZiTextModelFailureError(attempts) {
    const failures = attempts
        .filter(attempt => attempt.provider === 'tuZi' && attempt.status === 'failure')
        .map(attempt => `${attempt.model}: ${attempt.error || 'unknown error'}`);

    if (failures.length === 0) {
        return new Error('tuZi API全部候选模型失败');
    }

    return new Error(`tuZi API全部候选模型失败: ${failures.join(' | ')}`);
}

function pickGoodnightTuZiPrimaryModel() {
    const randomIndex = Math.floor(Math.random() * LEGACY_TUZI_TEXT_MODELS.length);
    return LEGACY_TUZI_TEXT_MODELS[randomIndex];
}

// 调用tuZi API生成文本(备用方案)
async function generateTextWithTuZi(prompt, options = {}) {
    const config = configLoader.getConfig();
    // 优先使用 ai.text.tuZi 配置(文本生成专用),其次使用 ai.comic.tuZi(兼容旧配置)
    const tuziConfig = config.ai?.text?.tuZi || config.aiServices?.tuZi || {};
    const primaryModel = options.primaryModel || pickGoodnightTuZiPrimaryModel();

    // 先判断迁移模型，避免旧入口在路由前要求 Tuzi key。
    if (isDaiYuTextModel(primaryModel)) {
        console.warn(`⚠️  ${primaryModel} 已迁移到 daiYu，改走 daiYu/${DAIYU_PRIMARY_MODEL} thinking 链路`);
        return generateTextWithDaiYu(prompt, {
            ...options,
            primaryModel: DAIYU_PRIMARY_MODEL
        });
    }

    const textApiKey = configLoader.getTuZiTextApiKey();
    if (!configLoader.isTuZiTextConfigured()) {
        throw new Error('tuZi API未配置,请检查secrets.json中的apiKey');
    }

    console.log('🤖 调用tuZi API生成文本...');

    const configuredFallbackModels = Array.isArray(tuziConfig.fallbackModels)
        ? tuziConfig.fallbackModels
        : [];
    const builtInFallbackModels = tuziConfig.includeBuiltInFallbackModels === true
        ? ['qwen2.5-72b-instruct', 'grok-4.1']
        : [];
    const modelSequence = [
        primaryModel,
        tuziConfig.textModel,
        tuziConfig.model,
        ...configuredFallbackModels,
        'gemini-3-flash-preview',
        ...builtInFallbackModels
    ].filter((model, index, models) => model && !isDaiYuTextModel(model) && models.indexOf(model) === index);
    console.log(`   晚安主模型随机命中: ${primaryModel}`);
    console.log(`   候选序列: ${modelSequence.join(' -> ')}`);
    const baseUrl = tuziConfig.baseUrl || 'https://api.tu-zi.com';
    const apiUrl = `${baseUrl}/v1/chat/completions`;
    const attempts = Array.isArray(options.attempts) ? [...options.attempts] : [];
    const sharedPromptCacheInfo = getSharedPromptCacheInfo(prompt);
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
            // 获取超时时间 (默认 60 秒)
            const timeoutMs = Number(options.timeoutMs) || config.timeouts?.aiApiTimeout || 60000;
            console.log(`[WAIT] 正在通过tu-zi.com API生成文本... (尝试 ${attempt + 1}/${modelSequence.length} model: ${textModel}, 超时: ${Math.round(timeoutMs / 1000)}s)`);
            const effectiveMaxTokens = normalizeTuZiTextMaxTokens(textModel, tuziConfig.maxTokens, wordLimit);
            console.log(`   max_tokens: ${effectiveMaxTokens} (configured=${tuziConfig.maxTokens || 'default'}, wordLimit=${wordLimit})`);

            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${textApiKey}`,
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
            const promptUsage = getPromptTokenUsage(usage);
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
                promptTokens: promptUsage.promptTokens,
                cachedTokens: promptUsage.cachedTokens,
                ...sharedPromptCacheInfo,
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
            await maybeNotifyTuZiBalanceError(error, `文本生成 ${textModel}`);

            // 如果是最后一次尝试,抛出包含所有候选模型失败原因的错误
            if (attempt === modelSequence.length - 1) {
                throw buildTuZiTextModelFailureError(attempts);
            }

            // 等待一小段时间后重试
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}

// 调用daiYu API生成文本（OpenAI兼容，支持thinking）
async function generateTextWithDaiYu(prompt, options = {}) {
    const config = configLoader.getConfig();
    const daiYuConfig = config.ai?.text?.daiYu || {};

    const apiKey = configLoader.getDaiYuApiKey();
    if (!configLoader.isDaiYuTextConfigured()) {
        throw new Error('daiYu API未配置,请检查secret.json中的providers.daiYu.apiKey');
    }

    console.log('🤖 调用daiYu API生成文本...');
    const primaryModel = normalizeDaiYuTextModel(
        options.primaryModel || daiYuConfig.model || DAIYU_PRIMARY_MODEL
    );

    const configuredFallbackModels = Array.isArray(daiYuConfig.fallbackModels)
        ? daiYuConfig.fallbackModels
        : [];
    const builtInFallbackModels = daiYuConfig.includeBuiltInFallbackModels === true
        ? ['qwen2.5-72b-instruct', 'grok-4.1']
        : [];
    const modelSequence = [
        primaryModel,
        daiYuConfig.textModel,
        daiYuConfig.model,
        ...configuredFallbackModels,
        DAIYU_PRIMARY_MODEL,
        ...builtInFallbackModels
    ].map(normalizeDaiYuTextModel)
        .filter((model, index, models) => model && models.indexOf(model) === index);
    console.log(`   晚安主模型: ${primaryModel}`);
    console.log(`   候选序列: ${modelSequence.join(' -> ')}`);
    const baseUrl = (daiYuConfig.baseUrl || 'http://localhost:8080').replace(/\/v1$/, '');
    const apiUrl = `${baseUrl}/v1/chat/completions`;
    const attempts = Array.isArray(options.attempts) ? [...options.attempts] : [];
    const sharedPromptCacheInfo = getSharedPromptCacheInfo(prompt);
    const fallbackFromPrimary = Boolean(options.fallback);
    const wordLimit = Number(options.wordLimit || configLoader.getByPath('ai.defaultWordLimit', 100));

    // 设置代理
    let agent = null;
    if (daiYuConfig.proxy) {
        console.log(`   使用代理: ${daiYuConfig.proxy}`);
        agent = new HttpsProxyAgent(daiYuConfig.proxy);
    }

    // thinking 配置
    const thinkingEnabled = daiYuConfig.thinking?.enabled !== false;
    const thinkingBudgetTokens = daiYuConfig.thinking?.budgetTokens || 10000;

    // 重试逻辑
    for (let attempt = 0; attempt < modelSequence.length; attempt++) {
        const textModel = modelSequence[attempt];
        try {
            const timeoutMs = Number(options.timeoutMs) || config.timeouts?.aiApiTimeout || 60000;
            console.log(`[WAIT] 正在通过daiYu API生成文本... (尝试 ${attempt + 1}/${modelSequence.length} model: ${textModel}, 超时: ${Math.round(timeoutMs / 1000)}s)`);
            const effectiveMaxTokens = normalizeTuZiTextMaxTokens(textModel, daiYuConfig.maxTokens, wordLimit);
            console.log(`   max_tokens: ${effectiveMaxTokens} (configured=${daiYuConfig.maxTokens || 'default'}, wordLimit=${wordLimit})`);

            const cachePlan = getExplicitPromptCachePlan(prompt, config, textModel);
            let requestBody = {
                model: textModel,
                messages: buildOpenAITextMessages(prompt),
                temperature: daiYuConfig.temperature,
                max_tokens: effectiveMaxTokens
            };
            requestBody = applyExplicitPromptCache(requestBody, cachePlan);
            if (cachePlan.enabled) {
                console.log(
                    `   prompt cache: explicit, rollout=${cachePlan.rolloutPercent}%, ` +
                    `bucket=${cachePlan.rolloutBucket}, prefixChars=${cachePlan.sharedPromptPrefixChars}`
                );
            }

            if (thinkingEnabled) {
                requestBody.thinking = {
                    type: 'enabled',
                    budget_tokens: thinkingBudgetTokens
                };
                console.log(`   thinking: enabled (budget=${thinkingBudgetTokens})`);
            }

            const postRequest = body => fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body),
                agent: agent,
                timeout: timeoutMs
            });

            let response = await postRequest(requestBody);
            let promptCacheFallbackReason;
            if (!response.ok && response.status === 400 && cachePlan.enabled) {
                const cacheErrorText = await response.text();
                promptCacheFallbackReason = `HTTP 400: ${cacheErrorText}`.slice(0, 300);
                console.warn(`⚠️  显式 prompt cache 参数被上游拒绝，改用普通请求: ${promptCacheFallbackReason}`);
                requestBody = {
                    ...requestBody,
                    messages: buildOpenAITextMessages(prompt)
                };
                delete requestBody.prompt_cache_key;
                delete requestBody.prompt_cache_options;
                response = await postRequest(requestBody);
            }

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`daiYu API返回错误 ${response.status}: ${errorText}`);
            }

            const data = await response.json();
            const choice = data.choices?.[0];
            const finishReason = getTuZiFinishReason(choice);
            const usage = data.usage || null;
            const promptUsage = getPromptTokenUsage(usage);
            const text = choice?.message?.content;
            console.log(`   finish_reason: ${finishReason || 'unknown'}, usage: ${usage ? JSON.stringify(usage) : 'unknown'}`);

            if (!text || text.trim().length === 0) {
                throw new Error('daiYu API返回空结果');
            }

            if (finishReason && ['length', 'max_tokens', 'MAX_TOKENS'].includes(String(finishReason))) {
                throw new Error(`daiYu API输出达到长度上限,疑似被截断 (finish_reason=${finishReason}, max_tokens=${effectiveMaxTokens})`);
            }

            if (isUnsafeGeneratedReply(text)) {
                throw new Error('daiYu API返回疑似拒绝/身份自述内容,跳过该模型');
            }

            attempts.push({
                provider: 'daiYu',
                model: textModel,
                status: 'success',
                finishReason: finishReason || 'unknown',
                promptTokens: promptUsage.promptTokens,
                cachedTokens: promptUsage.cachedTokens,
                cacheWriteTokens: promptUsage.cacheWriteTokens,
                ...sharedPromptCacheInfo,
                explicitPromptCache: cachePlan.enabled ? 'requested' : 'not_selected',
                promptCacheRolloutBucket: cachePlan.rolloutBucket,
                promptCacheFallbackReason,
                completionTokens: usage?.completion_tokens ?? usage?.completionTokens,
                reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens,
                totalTokens: usage?.total_tokens ?? usage?.totalTokens,
                maxTokens: effectiveMaxTokens
            });
            console.log('✅ daiYu API调用成功');
            return createGenerationResult(text, {
                provider: 'daiYu',
                model: textModel,
                fallback: fallbackFromPrimary || attempt > 0,
                attempts,
                finishReason: finishReason || 'unknown',
                usage,
                maxTokens: effectiveMaxTokens
            });
        } catch (error) {
            attempts.push({
                provider: 'daiYu',
                model: textModel,
                status: 'failure',
                error: String(error.message || error).slice(0, 300)
            });
            console.error(`❌ daiYu API调用失败 (尝试 ${attempt + 1}/${modelSequence.length}): ${error.message}`);

            if (attempt === modelSequence.length - 1) {
                throw buildTuZiTextModelFailureError(attempts);
            }

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

        // Gemini 失败时优先回退到 daiYu，避免再走旧的 Tuzi 文本模型。
        if (configLoader.isDaiYuTextConfigured()) {
            console.warn(`⚠️  Gemini API调用失败 (${error.message}),尝试使用daiYu API作为备用方案...`);
            try {
                return await generateTextWithDaiYu(prompt, {
                    fallback: true,
                    wordLimit: options.wordLimit,
                    attempts: [{
                        provider: 'gemini',
                        model: geminiConfig.model || 'unknown',
                        status: 'failure',
                        error: String(error.message || error).slice(0, 300)
                    }]
                });
            } catch (daiyuError) {
                console.error(`❌ daiYu API备用方案也失败: ${daiyuError.message}`);
                throw new Error(`Gemini和daiYu API都失败: Gemini - ${error.message}, daiYu - ${daiyuError.message}`);
            }
        }

        if (configLoader.isTuZiConfigured()) {
            console.warn(`⚠️  daiYu未配置，Gemini失败后尝试旧tuZi备用方案...`);
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
            if (attempt.promptTokens !== undefined) {
                lines.push(`    promptTokens: ${Number(attempt.promptTokens)}`);
            }
            if (attempt.cachedTokens !== undefined) {
                lines.push(`    cachedTokens: ${Number(attempt.cachedTokens)}`);
            }
            if (attempt.cacheWriteTokens !== undefined) {
                lines.push(`    cacheWriteTokens: ${Number(attempt.cacheWriteTokens)}`);
            }
            if (attempt.reasoningTokens !== undefined) {
                lines.push(`    reasoningTokens: ${Number(attempt.reasoningTokens)}`);
            }
            if (attempt.sharedPromptCacheKey) {
                lines.push(`    sharedPromptCacheKey: ${yamlQuote(attempt.sharedPromptCacheKey)}`);
            }
            if (attempt.sharedPromptPrefixChars !== undefined) {
                lines.push(`    sharedPromptPrefixChars: ${Number(attempt.sharedPromptPrefixChars)}`);
            }
            if (attempt.explicitPromptCache) {
                lines.push(`    explicitPromptCache: ${yamlQuote(attempt.explicitPromptCache)}`);
            }
            if (attempt.promptCacheRolloutBucket !== undefined) {
                lines.push(`    promptCacheRolloutBucket: ${Number(attempt.promptCacheRolloutBucket)}`);
            }
            if (attempt.promptCacheFallbackReason) {
                lines.push(`    promptCacheFallbackReason: ${yamlQuote(attempt.promptCacheFallbackReason)}`);
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
                const picks = lines.slice(0, 5).map((l, i) => `${i + 1}. ${l}`);
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
                const liveTimeDesc = buildLiveTimeDesc(highlightPath);
                const liveContext = liveGenerationContext.loadLiveGenerationContext(
                    highlightPath,
                    finalRoomId,
                    config
                );
                console.log(`🧭 晚安回复采用本场事实上下文: 标题=${liveContext.liveTitle || '未取得'}, 近期动态=${liveContext.recentDynamics?.length || 0}条`);
                // 构建提示词
                const prompt = buildPrompt(highlightContent, finalRoomId, liveTimeDesc, liveContext);
                const wordLimit = configLoader.getWordLimit(finalRoomId);
                // 调用API生成文本
                let generationResult;
                const provider = config.ai?.text?.provider || 'gemini';
                const attemptPrompt = attempt === 1
                    ? prompt
                    : `${prompt}

【失败重试纠错】上一版未通过发布前校验。再次生成时可以直接从本场具体内容起笔，不必补主播称呼；绝不能以粉丝昵称“${configLoader.getNames(finalRoomId).fan}”开头。只输出最终评论。`;

                if (provider === 'tuZi') {
                    generationResult = await generateTextWithTuZi(attemptPrompt, { wordLimit });
                } else if (provider === 'daiYu') {
                    generationResult = await generateTextWithDaiYu(attemptPrompt, { wordLimit });
                } else {
                    // 默认使用 Gemini
                    generationResult = await generateTextWithGemini(attemptPrompt, { wordLimit });
                }

                const rawGeneratedText = generationResult.text;
                const inspection = inspectGeneratedReply(rawGeneratedText, wordLimit, finalRoomId);
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

                const generatedText = validateGeneratedReply(rawGeneratedText, wordLimit, finalRoomId);
                console.log(`✅ 文本长度校验通过: ${generatedText.length} 字符 (wordLimit=${wordLimit})`);

                // 确定输出路径
                // 保存结果
                return saveGeneratedText(outputPath, generatedText, highlightPath, generationResult.meta);

            } catch (error) {
                lastError = error;
                console.error(`❌ 生成晚安回复失败 (第 ${attempt}/${maxRetries} 次尝试): ${error.message}`);

                if (attempt < maxRetries) {
                    const waitTime = 2000 * attempt;
                    console.log(`⏳ 等待 ${waitTime / 1000} 秒后重试...`);
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
    if (!cleaned || cleaned.length > 70 || /\n/.test(cleaned)) {
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
        ...buildClipTitlePromptLines({ streamerName: context.streamerName }),
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
            : provider === 'daiYu'
            ? await generateTextWithDaiYu(prompt, { wordLimit: 80 })
            : await generateTextWithGemini(prompt, { wordLimit: 80 });
        return cleanShortTitle(result.text, fallback);
    } catch (error) {
        console.warn(`⚠️  AI切片标题生成失败，使用模板标题: ${error.message}`);
        return fallback;
    }
}

/**
 * Shared title-writing instructions for every clip workflow.
 * Keep this as the single source of truth: callers only provide their output
 * contract (plain title vs. a JSON title field) and their clip-specific context.
 */
function buildClipTitlePromptLines(options = {}) {
    const outputFormat = options.outputMode === 'jsonTitle'
        ? '输出格式：每个 clips 元素的 title 字段只写标题本身，不要解释、不要引号、不要以"【"开头。18-42字为宜，最多52字，宁可稍长换信息量，也不要写成空泛短句。'
        : '输出格式：只输出标题本身，不要解释、不要引号、不要以"【"开头。18-42字为宜，最多52字，宁可稍长换信息量，也不要写成空泛短句。';
    const streamerName = String(options.streamerName || '').trim();
    const speakerRule = streamerName
        ? `主播身份：本段录播的主播是“${streamerName}”。标题中描述“主播/她/其发言”时必须指向${streamerName}；字幕中出现的其他名字或团体名称，除非上下文明确说明，否则只能视为被提及对象，不能改写为本段主播、其粉丝团体或其发言。`
        : '主播身份：以随后的“主播”字段为准。字幕中出现的其他名字或团体名称，除非上下文明确说明，否则只能视为被提及对象，不能改写为本段主播、其粉丝团体或其发言。';

    return [
        '给一个B站直播切片生成投稿标题，风格要像人工编辑挑出来的切片标题——一眼能看出"发生了什么好玩/离谱的事"，让人想点进去看，而不是平铺直叙的内容摘要。',
        '',
        '核心写法：找这段切片里最值得点开的那一个具体看点（一个疑问、一句原话、一个反差、一个翻车或结果），用"具体事件/疑问 + 原话/反差/结果"的结构写成一句话，可以用问句、冒号或感叹句。只抓一个点，不要试图概括整段内容。',
        '',
        '真实性要求：标题里的事实、人物关系、结果，必须能被下面的字幕或弹幕内容逐句对应，不能编造或夸大。ASR可能有同音错字，要结合上下文推断说话人真实的意思。"炸锅""破防""社死""离谱"这类情绪词，只有内容明确支持时才用，不要当万能后缀套上去；也不要写成"聊到了XX""锐评XX引发热议"这种谁都能套用的弱标题。',
        '',
        speakerRule,
        '',
        outputFormat,
        '',
        '人工标题参考风格：',
        '- 第二次复活怎么还往回走，弹幕急死了，路痴实锤',
        '- 如果我捡到死亡笔记，比夜神月用得好！和AI辩论，被骂生气了',
        '- 妈妈突然进房间，赶紧把电脑画面切到桌面',
        '- 主播每天受长文回复感动，今天才发现竟然是AI！看完识破AI的视频，问到底是谁做的',
        '- 两个男的在阳台是什么动画？原来是格里菲斯，弹幕怎么不知道',
        '- 读打抛猪猪包，烫嘴，谁想的名字。然后开麦当劳会员',
    ];
}

/**
 * Instructions for a second, deliberately short piece of copy used only on
 * the cover.  Upload titles carry context; cover text has to work as a
 * thumbnail and therefore needs a different length and hierarchy.
 */
function buildCoverTextPromptLines() {
    return [
        '同时为每段切片提供 coverText（封面文案）。它不是投稿标题的截断版，而是给 16:9 缩略图看的两行大字：第一行给铺垫，第二行给最想点开的结果/原话/反差。',
        'coverText 格式：必须恰好两行，在 JSON 字符串中用 \\n 表示换行；第一行 4-9 个汉字（可含很短数字），第二行 5-11 个汉字，总字数尽量不超过 18。',
        '封面文案只抓一个可验证的钩子，保留原话、疑问或结果，不要复述整段；不要写“小岁/岁己”、直播切片、tag、表情、书名号、括号或营销套话。',
        '示例：投稿标题“提建议被当成找茬？小岁委屈控诉：你们不宠我了，只会从我身上找问题！” → coverText “你们不宠我了\\n只会找我问题！”',
        '示例：投稿标题“充电一小时电量仅剩22%？蓝色充电头终于寿终正寝” → coverText “充一小时只剩22%\\n蓝头寿终正寝”',
    ];
}

function buildClipDescriptionPromptLines() {
    return [
        '简介要求：',
        '- 50字以内，一句话写清片中发生的具体事件，优先交代人物、做法和结果。',
        '- 简介面向观众，只陈述片中内容；不要写选片理由或效果评估，也不要暴露弹幕统计、关键词命中、情绪或声音标签等内部判据。',
        '- 若弹幕的具体发言推动了事件，只描述互动内容，不概括反应数量或强度。',
        '- 准确自然，不夸大，不写广告腔。',
    ];
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
        ...buildClipDescriptionPromptLines(),
        '- 只输出简介文字，不要解释，不要引号。',
        '- 准确基于上下文；ASR可能有同音错字，要根据语境推断。',
        '- 提到其他主播时直接用名字。',
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
            : provider === 'daiYu'
            ? await generateTextWithDaiYu(prompt, { wordLimit: 80 })
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
    buildPrompt,
    generateClipTitle,
    generateClipDescription,
    buildClipTitlePromptLines,
    buildCoverTextPromptLines,
    buildClipDescriptionPromptLines,
    inspectGeneratedReply,
    generateTextWithGemini,
    generateTextWithTuZi,
    generateTextWithDaiYu,
    getPromptTokenUsage,
    getSharedPromptCacheInfo,
    getExplicitPromptCachePlan,
    buildOpenAITextMessages,
    applyExplicitPromptCache,
    buildTextFrontMatter,
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

                const config = configLoader.getConfig();
                const provider = config.ai?.text?.provider || 'gemini';
                const generated = provider === 'tuZi'
                    ? await generateTextWithTuZi(prompt, { wordLimit: 600 })
                    : provider === 'daiYu'
                    ? await generateTextWithDaiYu(prompt, { wordLimit: 600 })
                    : await generateTextWithGemini(prompt, { wordLimit: 600 });
                // Keep stdout script-only for the Python caller; provenance is
                // emitted as a terminal stderr sentinel for machine parsing.
                process.stdout.write(generated.text + '\n');
                process.stderr.write(`[[TEXT_GENERATION_META]] ${JSON.stringify({
                    provider: generated.provider,
                    model: generated.model,
                    fallback: Boolean(generated.fallback),
                    attempts: generated.attempts || []
                })}\n`);
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
