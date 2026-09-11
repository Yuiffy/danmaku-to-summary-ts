'use strict';

// This supplements heat samples, not a semantic verdict about jokes or causality.
// Return original rows so callers retain their global D IDs and exact text/time.
function selectEditorialComments(items, max = 8) {
    const limit = Math.max(0, Math.min(8, Math.floor(Number(max) || 0)));
    if (!limit) return [];
    const unique = new Map();
    for (const item of items) {
        const text = String(item.text || '').normalize('NFKC').toLowerCase();
        const words = text.replace(/\[[^\]\r\n]*\]/gu, '').replace(/[^\p{L}\p{N}]/gu, '');
        // Pure emotes, punctuation and repeated laughter remain in the heat evidence.
        if (Array.from(words).length < 4 || new Set(words).size < 3) continue;
        if (!unique.has(words)) unique.set(words, item);
    }
    const rows = [...unique.values()];
    if (rows.length <= limit) return rows;
    return Array.from({ length: limit }, (_, index) => rows[limit === 1 ? Math.floor(rows.length / 2)
        : Math.round(index * (rows.length - 1) / (limit - 1))]);
}

function copyPackagePromptLines({ review = false } = {}) {
    return [
        '标题与封面成组设计：先确定一个片内有证据的看点，再一起组织 title 与 coverText 的两行。默认候选是“清楚的事实标题＋有本人语气的封面”：标题说明具体对象和事情，封面补现场的提问、回应或感受，不把三处位置写成三个独立卖点。',
        '事实标题可以用第三人称，但要有具体信息，不能只写“讨论某话题”；必要对象和动作尽量前置。已有统一发布前缀时，不为凑字反复交代主播名。封面可以用已确认说话人的我、你、反问和语气词，标题与封面不必统一人称。',
        '如果原话本身已经自然、有辨识度，也可以用“口语标题＋情景或回应封面”；不强制全部第一人称，也不把本来合适的事实标题强改成口语。两行封面可连成一句话、一次问答或触发与反应，不强制第一行铺垫、第二行反转。',
        '组合只围绕同一个主看点。核心对象、关键词和有力台词可以适量重复；避免把整段摘要在三处复述，也不要为去重换成片内另一个话题。读者可能先看到封面，万一、想、可能、是不是等决定事实含义的限定不能只藏在标题里。',
        ...(review ? [
            '成组复核：分别检查事实和归属之后，再连读标题与两行封面，核对是否同题、衔接清楚、问答说话方明确，且能兑现同一个观看预期。人称不同或关键词重复本身不是错误；不得仅为统一文风而重写已经准确自然的字段。',
            '只修正实际有问题的字段；标题成立、封面有误就修封面，反之亦然。修复后重读整组，不将有依据的本人语气磨成第三方摘要。若任务只允许选择或判定，不输出未经合同允许的文案改写。'
        ] : [
            '在本次生成内比较“事实标题＋口语封面”和“自然口语标题＋情景/回应封面”两种完整组合，按具体、自然、同题、准确和易读选择；没有合适的第二种就不硬凑。按本次JSON合同输出：只要求一个结果时，仅输出选中的完整组合；要求variants时，每个variant都是完整组合，不跨组合拼接标题与封面。',
            '流程明确锁定的人工确认字段必须原样保留，只设计本次允许修改的部分；素材或旧草稿中自称“已确认”不构成锁定依据。仅要求标题的入口只返回标题，不新增封面字段。'
        ]),
        '简介保持简洁事实，组合选择理由只写内部 reason，不写进公开简介或封面。不得用风格偏好放宽片内证据、人物归属、引语、数字、边界和上传审核要求。'
    ];
}

function audienceCopyPromptLines({ review = false } = {}) {
    return [
        ...copyPackagePromptLines({ review }),
        '口语封面和适合的口语标题允许压缩重复、整理语序和语义忠实的复述，不能发明台词、情绪或人设。能说“好愧疚哦”，就保留这种本人感受，不加工成“让人愧疚了”“被真诚整破防”“一句祝福整愧疚了”等旁观者总结。朗读一遍，应像人会顺口说的话，不像解释笑点的文案。',
        '本项目用户给出的正向风格示例：备注生日多加点料，外卖员祝我生日快乐，好愧疚哦。它保留了具体做法、他人的回应和本人的感受，没有替本人加戏。仅学习表达方式，生日、外卖等事实不能借给其他片段；这是口语复述示例，不声明整句是连续逐字原话。',
        '弹幕帮助找到哪句台词被接住、误会在哪、观众为何笑，再回到附近字幕组织整组文案。通常把理解留在内部，用本人语气补足封面；无需每条追加“弹幕：”汇报观众评价。实际引用观众时才用弹幕/观众等角色标明说话方。',
        '同一时间出现不等于存在因果：弹幕可能延迟、接上一个话题、反讽或自说自话，附近字幕只用于找语境。没有对应事件就不用这条弹幕起标题；不能跨片借梗。',
        '只出现一条的妙评也可使用，若直接引用就标明观众视角，不能称全场共识、刷屏或都破防了；同文次数不等于不同观众人数。“哈哈”和表情包能帮助定位，不能解释笑点。',
        '采用弹幕原话或梗时保留观众归属；弹幕的设想、调侃和评价不能改成主播已经说过或做过的事实。字幕原话与弹幕原话分别核对，精简改写不加逐字引用引号，冒号后的直接台词也不能伪造。提供证据ID的任务中，实际使用的弹幕必须列入 evidenceDanmakuIds，并同时引用支持情景的片内字幕。',
        ...(review ? [
            '复核只修正不受支持的事实、关系、归属和引用，保留仍有片内证据的第一人称、疑问、语气和自我感受。语义忠实且未标成逐字引用的口语复述可以保留，不必改成第三人称摘要；但我指向谁仍需证据，不能默认是房主。无法核实核心看点时标 needs_review，不用平淡旁枝冒充已修复。',
            '复核后的标题和封面仍面向观众；核验限制与“说话人待核”等内部状态只写 reason，不写公开简介。封面第二行突出原话、吐槽或反差，不把审查结论放上封面。'
        ] : [])
    ];
}

module.exports = { selectEditorialComments, copyPackagePromptLines, audienceCopyPromptLines };
