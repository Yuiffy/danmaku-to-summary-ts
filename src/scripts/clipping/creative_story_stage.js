'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeJsonAtomic } = require('./candidate_subtitles');
const { editorialProfile, sameEditorialProfile } = require('./creative_profile');
const { creativeSettings } = require('./creative_plan');
const { chooseMusicForDialogue, dialogueRmsFromPcm } = require('./creative_audio_audit');
const timelineTools = require('./creative_timeline');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

/** Content selection and bounded story repair; retains all existing editorial decisions. */
async function runCreativeStory(input, io) {
    const { baseline, context, sourceId, sourceDuration, scratch, directory, name, assets, limits, creativeOptions } = input;
    const { config, options, clip, parsed, subtitleEvidence, danmaku, topic } = context;
    const { request, sourceContext, routeSourceRequirements, withMedia, mediaConfig, history, logs, restore, updateProfile } = io;
    let { speech, audience, renderSrt } = input;
    let profile = null, timeline = null, duration = sourceDuration;
    const surroundingSpeech = (Array.isArray(subtitleEvidence.cues) ? sourceContext() : parsed.segments).filter(row => row.end > baseline.window.start - 30
        && row.start < baseline.window.end + require('./topic_edit_plan').contextSeconds(config))
        .map(row => ({ id: row.id, start: row.start - baseline.window.start, end: row.end - baseline.window.start, text: row.text }));
    const contextSha256 = hash(JSON.stringify({ surroundingSpeech, topicEditPlan: clip.topicEditPlan || null }));
    const sourceCues = topic.parseTopicSrt(baseline.output.srtPath).segments.map((row, i) => ({ ...row, id: `C${i + 1}` }));
    const protectedSpans = timelineTools.protectedStorySpans(clip, subtitleEvidence, danmaku, baseline.window, baseline.sourceExpansion);
    const protectedCues = timelineTools.protectedStoryCues(protectedSpans, sourceCues);
    const protectionRules = 'protectedCues把原始证据组映射到本片字幕编号，列出的cueIds全部必留；protectedSpans的整个时间范围仍须覆盖，包括组内停顿。'
        + 'keep用字幕编号选择完整原话；程序会在最终保留句后自动留最多3秒余韵，受素材末尾和下一句限制。字幕结束后的片尾留白不需要字幕编号，不构成必留原话冲突。'
        + '证据组可能包含开场过渡或转写疑词，不得为了精简开头删除其中一句，不把转写疑词当成剪辑错误。'
        + '若必留内容确实与完整性要求无法兼容，应明确报告冲突并停止，不得要求删除它来通过审核。';
    writeJsonAtomic(path.join(scratch, 'story-input.json'), { sourceDuration, copy: baseline.copy, sourceCues, protectedSpans, protectedCues });
    const storyPrompt = '先识别内容与语气再剪辑。游戏保留关键操作/路线和反应；杂谈、故事、连麦保留人物关系、铺垫和接话；教程保留步骤与解释；演唱、演奏、朗读等连续表演保留完整乐句和段落，不在内部乱剪。'
        + '删掉重复说明、无进展操作及支线，但不为了固定压缩比例删必要内容。只选给出的完整字幕句组，按原顺序，不改话、不挪因果，必须覆盖protectedSpans。'
        + '同时给出profile：kind=gameplay/conversation/story/tutorial/performance/mixed；tone=comic/neutral/serious；density=dense/moderate/light；preserveContinuity为布尔；music=playful/none；laughter为布尔；reason说明依据。中性/严肃内容不要笑声或轻快BGM，连续表演必须preserveContinuity=true且music=none、laughter=false。'
        + '返回 {"profile":{"kind":"gameplay","tone":"comic","density":"dense","preserveContinuity":false,"music":"playful","laughter":true,"reason":"具体内容依据"},"keep":[{"fromCue":"C1","toCue":"C6","role":"setup","reason":"建立起因"},...]}；role可用setup/escalation/reaction/payoff/context/step/explanation/performance/closing，每组须有内容理由。\n'
        + protectionRules + '\n'
        + (context.creativeStoryFeedback ? '上次成片审核指出片内可修复的必要内容问题，本轮必须在当前素材中修复，并保留有效删减：' + JSON.stringify(context.creativeStoryFeedback) + '\n' : '')
        + (clip.topicEditPlan ? '选材阶段已规划完整话题：必须保留全部keep段（包括第二个例子、后续回应及结尾），不得重新只挑首次笑点；drop段不恢复。使用给出的已映射C字幕keep草案。\n'
            + JSON.stringify({ plan: clip.topicEditPlan, keep: require('./topic_edit_plan').subtitleKeepDraft(clip.topicEditPlan, sourceCues, baseline.window) }) : '')
        + (baseline.sourceExpansion ? '\n本轮已根据独立审核从原录播扩展素材，重新编号C字幕。旧选材keep/drop仍按原来的绝对范围保留，旧结尾保护不延伸到整个新窗。新增R引用已映射为protectedCues，须保留完整起因、回答与收束；其余新增字幕可以按完整句组删冗余或无关转场。素材外窗的最后一句不等于成片必留结尾，收束当前主题即可，不要接入无关唱歌、找伴奏或新的游戏。不要机械照抄旧keep草案而漏掉新增必要内容。\n' : '')
        + JSON.stringify({ duration: sourceDuration, copy: baseline.copy, cues: sourceCues, protectedSpans, protectedCues });
    const acceptStory = draft => {
        profile = editorialProfile(draft.profile, { legacy: Boolean(options.creativeResumeDirectory && logs.at(-1)?.status === 'reused_draft') });
        updateProfile(profile);
        const timeline = timelineTools.validateStoryPlan(draft, sourceCues, sourceDuration, protectedSpans, profile, 3);
        if (clip.topicEditPlan) require('./topic_edit_plan').assertDroppedRanges(timeline, clip.topicEditPlan, baseline.window);
        return timeline;
    };
    const applyMusicSuitability = async () => {
        if (profile.music !== 'playful') return;
        const sample = path.join(scratch, 'dialogue-sample.pcm');
        let dialogueRms;
        try {
            await withMedia(mediaProfile => topic.runFfmpeg(['-v', 'error', '-y', '-ss', String(Math.max(0, sourceDuration * .2)),
                '-i', baseline.output.mediaPath, '-t', '20', '-map', '0:a:0', '-vn', '-ar', '16000', '-ac', '2', '-f', 'f32le', sample], mediaConfig(mediaProfile)));
            dialogueRms = dialogueRmsFromPcm(fs.readFileSync(sample));
        } finally { if (fs.existsSync(sample)) fs.unlinkSync(sample); }
        const decision = chooseMusicForDialogue(profile, dialogueRms);
        if (options.creativeResumeDirectory) {
            const previous = JSON.parse(fs.readFileSync(path.join(options.creativeResumeDirectory, 'clip.json'), 'utf8'));
            const spans = value => JSON.stringify(value?.keep.map(({ start, end }) => ({ start, end })));
            if (previous.qaResult?.status === 'passed' && previous.audioQa?.status === 'passed'
                && previous.creativePlan?.sourceId === sourceId && spans(previous.creativePlan.timeline) === spans(timeline)
                && previous.creativeResult?.history?.some(row => row.stage === 'audio_mix_repair' && row.action === 'omit_optional_music')
                && sameEditorialProfile({ ...profile, music: 'none' }, previous.editorialProfile)) {
                decision.enabled = false;
                decision.reason = 'Reuse verified mix without optional music; all audio checks rerun';
            }
        }
        if (!decision.enabled) { profile = { ...profile, music: 'none' }; updateProfile(profile); }
        history.push({ stage: 'music_suitability', dialogueRms, ...decision });
    };
    let draft = await request('story', 'keep', storyPrompt);
    const validateDraft = (value, stage) => require('./creative_story').validateStoryDraft(value,
        { accept: acceptStory, request, prompt: storyPrompt, stage, history });
    ({ draft, timeline } = await validateDraft(draft, 'story-repair'));
    await applyMusicSuitability();
    const reviewStory = stage => {
        const reviewEvidence = timelineTools.storyReviewEvidence(sourceCues, timeline, protectedSpans);
        writeJsonAtomic(path.join(scratch, `${stage}-input.json`), { profile, ...reviewEvidence, surroundingSpeech, contextSha256, copy: baseline.copy });
        if (stage === 'story-qa' && options.creativeResumeDirectory) {
            const previous = JSON.parse(fs.readFileSync(path.join(options.creativeResumeDirectory, 'clip.json'), 'utf8'));
            const prior = previous.creativeResult?.history?.find(row => row.stage === 'story');
            if (previous.qaResult?.status === 'passed' && prior?.qa?.approved === true && Array.isArray(prior.qa.issues)
                && !prior.qa.issues.length && prior.contextSha256 === contextSha256 && JSON.stringify(prior.timeline) === JSON.stringify(timeline)
                && sameEditorialProfile(profile, previous.editorialProfile)) {
                logs.push({ stage, status: 'reused_source_bound_review', source: options.creativeResumeDirectory });
                writeJsonAtomic(path.join(scratch, `${stage}-response.json`), { text: JSON.stringify(prior.qa), reusedFrom: options.creativeResumeDirectory });
                return Promise.resolve(prior.qa);
            }
        }
        return request(stage, 'approved', '按profile独立审核编辑后的内容。游戏/故事保留因果和收尾，联动保留人物关系和接话，教程保留必要步骤，表演保留乐句/段落连贯。判断语气、笑声和音乐选择是否符合原内容。合理删掉重复/支线，不要求保留所有原话，也不强求喜剧笑点或固定长度。'
        + '原声本来就有的口吃/自我修正不等于剪辑造成断句，只有删减导致语义断裂才拒绝；不能要求删除protectedSpans保护的文案依据。'
        + protectionRules + '原素材已有的短暂话题过渡本身不是新剪辑造成的语义断裂；仍须核查实际起因、指代、转折和收尾，不因必留而自动批准。'
        + '注意时间基准：original、timeline、protectedSpans是原片时间；kept.start/end是精剪后时间，kept.sourceStart/sourceEnd才是原片位置。不得把两种时间直接比较而误报删句。'
        + 'protectedCoverage给出程序已验证的覆盖结果及保留字幕编号；请核对具体原话与内容含义，不凭时间猜测不存在的漏句。'
        + 'surroundingSpeech包含素材窗口之外的真实前后文（时间可为负数或大于sourceDuration）。核对后面是否还有同一话题的第二例、反转、追问、自纠或结论；若原窗口截断本题，拒绝并报告需扩展素材，不能只凭片内通顺通过。'
        + '扩窗新增内容若否定此前结论或澄清人物归属，须对照copy逐项核查；不能仅凭旧引用仍保留就认定旧文案正确。新增素材中无关话题可不保留，收束当前主题即可。'
        + '只返回 {"approved":true,"needsSourceExpansion":false,"issues":[]}。有歪曲、断句、丢失必要上下文时approved=false并指出具体位置。'
        + 'sourceDuration是全部可用素材的长度，不是timeline.duration成片长度；original的C字幕是当前素材里所有可用句子，kept仅是成片。必要原话在original或0–sourceDuration内时只需修keep，needsSourceExpansion=false；只有真实R字幕在素材窗之外才为true。可用requiredSourceCueIds列需要补入的真实R编号。\n'
        + JSON.stringify({ profile, ...reviewEvidence, surroundingSpeech, topicEditPlan: clip.topicEditPlan || null, protectedSpans, protectedCues, copy: baseline.copy }));
    };
    let storyQa = await routeSourceRequirements(await reviewStory('story-qa'), 'story-qa');
    const incompleteSource = stage => {
        history.push({ stage: 'source_window_incomplete', timeline, qa: storyQa, contextSha256 });
        return { ...restore('source_window_incomplete: ' + (Array.isArray(storyQa.issues) ? storyQa.issues.join('；') : '需扩展素材后重新选材')),
            sourceExpansionRequest: { stage, qa: storyQa, sourceId } };
    };
    if (storyQa.needsSourceExpansion === true) return { result: incompleteSource('story-qa') };
    if (storyQa.approved !== true || !Array.isArray(storyQa.issues) || storyQa.issues.length) {
        history.push({ stage: 'story_qa_repair', timeline, qa: storyQa });
        try {
            draft = await request('story-qa-repair', 'keep', storyPrompt + '\n独立审核发现下述必要上下文问题，请修复，同时保留原来的有效删减：'
                + '不要一次只补一个ASR小块或半句话；当前素材内的连续问答、后续例子、自纠与最终结论应一次补齐到真正收束。检查最后保留字幕后面的多条原话，仍在同题继续就一起选入，不能把首个回答当整段结束。'
                + JSON.stringify(storyQa) + '\n上次计划：' + JSON.stringify(draft));
        } catch (error) {
            throw new Error(`Story repair failed; original QA: ${JSON.stringify(storyQa)}; request error: ${error.message}`, { cause: error });
        }
        ({ draft, timeline } = await validateDraft(draft, 'story-qa-constraint-repair'));
        await applyMusicSuitability();
        storyQa = await routeSourceRequirements(await reviewStory('story-qa-final'), 'story-qa-final');
        if (storyQa.needsSourceExpansion === true) return { result: incompleteSource('story-qa-final') };
    }
    history.push({ stage: 'story', timeline, qa: storyQa, contextSha256 });
    if (storyQa.approved !== true || !Array.isArray(storyQa.issues) || storyQa.issues.length) return { result: restore('story_qa_rejected: ' + JSON.stringify(storyQa)) };
    duration = timeline.duration;
    speech = timelineTools.mapTimelineCues(speech, timeline);
    audience = timelineTools.mapTimelineCues(audience.map(row => ({ ...row, start: row.time, end: row.time + .01 })), timeline).map(row => ({ time: row.start, text: row.text }));
    renderSrt = path.join(directory, `${name}.edited.srt`);
    fs.writeFileSync(renderSrt, timelineTools.srtText(timelineTools.mapTimelineCues(sourceCues, timeline)), 'utf8');
    if (profile.music === 'playful') { const music = require('./creative_music').createPlayfulMusic(scratch); assets[music.id] = music; }
    Object.assign(limits, creativeSettings({ ...creativeOptions, editorialDensity: profile.density }));
    if (profile.tone !== 'comic') limits.variety = false;
    writeJsonAtomic(path.join(scratch, 'story-plan.json'), { timeline, protectedSpans, protectedCues, sourceCues, storyQa });
    console.log(`CREATIVE_STORY: ${sourceDuration.toFixed(2)}s -> ${duration.toFixed(2)}s (${timeline.keep.length} ranges)`);
    return { profile, timeline, duration, speech, audience, renderSrt };
}

module.exports = { runCreativeStory };
