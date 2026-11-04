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
    // An explicit rate plan is an editorial instruction: the story must keep those
    // seconds so the requested acceleration can actually be applied. Keep spans are
    // cue-based, so hint edges are pulled to the nearest cue boundary — a half-gap of
    // silent footage is not worth a QA loop the story can never satisfy.
    const snapHintEdge = value => {
        const round = v => Math.round(v * 1000) / 1000;
        const cue = sourceCues.find(row => row.start < value - .001 && row.end > value + .001);
        if (cue) return round(value - cue.start <= cue.end - value ? cue.start : cue.end);
        const before = [...sourceCues].reverse().find(row => row.end <= value + .001);
        const after = sourceCues.find(row => row.start >= value - .001);
        if (!before) return round(after.start);
        if (!after) return round(before.end);
        return round(value - before.end <= after.start - value ? before.end : after.start);
    };
    const speedHints = (Array.isArray(options.creativeSpeedWindows) ? options.creativeSpeedWindows : [])
        .map(row => ({ start: snapHintEdge(Math.round((Number(row.start) - baseline.window.start) * 1000) / 1000),
            end: snapHintEdge(Math.round((Number(row.end) - baseline.window.start) * 1000) / 1000),
            rate: Number(row.rate ?? row.speed) }))
        .filter(row => Number.isFinite(row.start) && Number.isFinite(row.end) && row.end > row.start);
    const cutAfterAbsolute = Number(options.creativeCutAfter);
    const cutAfterSeconds = Number.isFinite(cutAfterAbsolute) && cutAfterAbsolute > 0
        ? cutAfterAbsolute - baseline.window.start : null;
    const keepTailAbsolute = Number(options.creativeKeepTailFrom);
    const keepTailSeconds = Number.isFinite(keepTailAbsolute) && keepTailAbsolute > 0
        ? keepTailAbsolute - baseline.window.start : null;
    // Silent-but-performed beats (laughter, sighs) are not dead air. They sit between
    // subtitles, so cue-based keep ranges would normally cut them away.
    const keepBeatSeconds = (Array.isArray(options.creativeKeepBeats) ? options.creativeKeepBeats : [])
        .map(row => ({ start: Number(row.start) - baseline.window.start, end: Number(row.end) - baseline.window.start }))
        .filter(row => Number.isFinite(row.start) && Number.isFinite(row.end)
            && row.end > row.start && row.start >= 0 && row.end <= sourceDuration);
    writeJsonAtomic(path.join(scratch, 'story-input.json'), { sourceDuration, copy: baseline.copy, sourceCues,
        protectedSpans, protectedCues, speedHints, keepBeatSeconds, cutAfterSeconds, keepTailSeconds });
    const storyPrompt = '先识别内容与语气再剪辑。游戏保留关键操作/路线和反应；杂谈、故事、连麦保留人物关系、铺垫和接话；教程保留步骤与解释；演唱、演奏、朗读等连续表演保留完整乐句和段落，不在内部乱剪。'
        + '删掉重复说明、无进展操作及支线，但不为了固定压缩比例删必要内容。只选给出的完整字幕句组，按原顺序，不改话、不挪因果，必须覆盖protectedSpans。'
        + '反应前有必要的无字幕动作时，keep组可选actionBeforeSeconds（0到12秒），表示首句前保留的总时长；程序仍在上一句结束处截住，不截断或恢复已删对白。按已核实的动作选择，不给所有切点固定加时；需保留更早对白时扩展fromCue。'
        + '同时给出profile：kind=gameplay/conversation/story/tutorial/performance/mixed；tone=comic/neutral/serious；density=dense/moderate/light；preserveContinuity为布尔；music=playful/none；laughter为布尔；reason说明依据。中性/严肃内容不要笑声或轻快BGM，连续表演必须preserveContinuity=true且music=none、laughter=false。'
        + '纯走路、找路、重复刷怪、无信息量的操作这类"过程性"内容，如果删掉会破坏路线或因果，可以在该keep组加speed（1.2–3倍；需要明显快进感时可到4–6倍，上限10倍）和speedReason，让画面与原声同步加速通过，而不是整段删除。只能加速escalation/context/step/explanation这类过程组；setup/payoff/reaction/closing/performance必须原速，笑点、反转和收束前后的反应不能加速。2.5倍及以上该段原字幕不再上屏、改由画面角标显示倍率与时长，因此只有不需要读文字的过程画面才用高倍速；2.5倍以下加速后每条保留字幕仍须至少0.75秒可读，宁可降低倍速。'
        + '返回 {"profile":{"kind":"gameplay","tone":"comic","density":"dense","preserveContinuity":false,"music":"playful","laughter":true,"reason":"具体内容依据"},"keep":[{"fromCue":"C1","toCue":"C6","role":"setup","reason":"建立起因"},...]}；role可用setup/escalation/reaction/payoff/context/step/explanation/performance/closing，每组须有内容理由。不需要加速时不要填speed。\n'
        + protectionRules + '\n'
        + (speedHints.length ? '运营指定了需要用加速通过的过程性区间（speedHints，本片秒数）：这些区间必须保留为完整keep段（role用escalation/context），不得整段删除，也不要再给它们填speed，程序会按指定倍速播放。\n' : '')
        + (options.creativeNoStorySpeed ? '本次运营明确要求：除上面的speedHints以外，任何keep段都不要自行填speed，后半段一律1x原速播放；节奏由运营指定，不要对加速提出异议。\n' : '')
        + (keepBeatSeconds.length ? `运营指定的无台词表演区间（keepBeats，本片秒）：${JSON.stringify(keepBeatSeconds.map(row => `${row.start.toFixed(2)}-${row.end.toFixed(2)}`))}。这些区间里是岁己的笑、叹气等反应，不是纯静音空白，必须完整保留：把区间前一句与后一句放进同一个keep段，不要在这里切断；程序也会强制兜底。它们之外真正无台词又无声音的纯静音空档才照常cut掉拼接。\n` : '')
        + (cutAfterSeconds !== null ? `运营指定硬切收尾：本片 ${cutAfterSeconds.toFixed(2)}s 之后的所有字幕整段删除（直接cut拼接，不加速）。只保留该时间点及之前的完整句组，keep段一律不要填speed（后半段1x原速播放），句与句之间的纯空白正常删掉即可。这是用户确认的最终结尾，不是漏剪，不要为"收尾完整"补入其后的任何台词。\n` : '')
        + (keepTailSeconds !== null ? `运营指定尾段强制保留：本片 ${keepTailSeconds.toFixed(2)}s 起到素材末尾的所有字幕句必须全部保留（keep段覆盖每一句，一句不删、一句不漏，这是用户确认过的成片结构）。句与句之间真正无台词又无声音的纯静音空档照常cut掉拼接；该尾段一律 1x 原速，keep段不要填speed。程序也会强制兜底。\n` : '')
        + (context.creativeStoryFeedback ? '上次成片审核指出片内可修复的必要内容问题，本轮必须在当前素材中修复，并保留有效删减：' + JSON.stringify(context.creativeStoryFeedback) + '\n' : '')
        + (clip.topicEditPlan ? '选材阶段已规划完整话题：必须保留全部keep段（包括第二个例子、后续回应及结尾），不得重新只挑首次笑点；drop段不恢复。使用给出的已映射C字幕keep草案。\n'
            + JSON.stringify({ plan: clip.topicEditPlan, keep: require('./topic_edit_plan').subtitleKeepDraft(clip.topicEditPlan, sourceCues, baseline.window) }) : '')
        + (baseline.sourceExpansion ? '\n本轮已根据独立审核从原录播扩展素材，重新编号C字幕。旧选材keep/drop仍按原来的绝对范围保留，旧结尾保护不延伸到整个新窗。新增R引用已映射为protectedCues，须保留完整起因、回答与收束；其余新增字幕可以按完整句组删冗余或无关转场。素材外窗的最后一句不等于成片必留结尾，收束当前主题即可，不要接入无关唱歌、找伴奏或新的游戏。不要机械照抄旧keep草案而漏掉新增必要内容。\n' : '')
        + JSON.stringify({ duration: sourceDuration, copy: baseline.copy, cues: sourceCues, protectedSpans, protectedCues,
            ...(speedHints.length ? { speedHints } : {}) });
    // Operator speed hints are contractual: the story must not trim inside them, or the
    // requested montage cannot be applied. Cue-level coverage is enforced here, before
    // validation, so a model that treats silent montage seconds as deletable gets corrected.
    const cueIndex = id => sourceCues.findIndex(row => row.id === id);
    const enforceSpeedHints = value => {
        if (!speedHints.length || !Array.isArray(value?.keep)) return value;
        for (const hint of speedHints) {
            // Boundary-touching cues count: a snapped hint edge often sits exactly on a
            // cue boundary, and that cue must join the keep span or the silent gap
            // between the two neighbouring cues reads as a deletion again.
            const inside = sourceCues.filter(row => row.start < hint.end + .001 && row.end > hint.start - .001);
            if (!inside.length) continue;
            const lo = cueIndex(inside[0].id), hi = cueIndex(inside[inside.length - 1].id);
            const overlapping = value.keep.filter(span => {
                const from = cueIndex(span.fromCue), to = cueIndex(span.toCue);
                return from >= 0 && to >= 0 && from <= hi && to >= lo;
            });
            if (!overlapping.length) {
                value.keep.push({ fromCue: inside[0].id, toCue: inside[inside.length - 1].id, role: 'context',
                    reason: `运营指定加速区间 ${hint.start}–${hint.end}s，画面按 speedHints 倍速通过` });
                continue;
            }
            const anchor = overlapping[0];
            anchor.fromCue = sourceCues[Math.min(cueIndex(anchor.fromCue), lo)].id;
            for (const span of overlapping) {
                anchor.toCue = sourceCues[Math.max(cueIndex(anchor.toCue), hi, cueIndex(span.toCue))].id;
            }
            value.keep = value.keep.filter(span => !overlapping.includes(span) || span === anchor);
        }
        // Operator-decreed montage regions are process footage by definition: a keep
        // span mostly inside the hints must not claim a guard-protected role, or the
        // rate plan is silently erased right before rendering.
        for (const span of value.keep) {
            const a = sourceCues[cueIndex(span.fromCue)], b = sourceCues[cueIndex(span.toCue)];
            if (!a || !b || !(b.end > a.start)) continue;
            const covered = speedHints.reduce((sum, hint) => sum + Math.max(0, Math.min(b.end, hint.end) - Math.max(a.start, hint.start)), 0);
            if (covered / (b.end - a.start) > .5) {
                span.role = 'context';
                span.reason = (span.reason ? span.reason + '；' : '') + '运营指定蒙太奇区间，程序按 speedHints 倍速通过';
            }
        }
        value.keep.sort((a, b) => cueIndex(a.fromCue) - cueIndex(b.fromCue));
        return value;
    };
    // A silent beat only survives if the span containing its preceding line is held
    // into the gap. When the model already kept both lines in one span, the beat is
    // inside that span and nothing needs to change.
    const enforceKeepBeats = value => {
        for (const beat of keepBeatSeconds) {
            const before = [...sourceCues].reverse().find(row => row.end <= beat.start + .001);
            if (!before) continue;
            const span = value.keep.find(row => row.toCue === before.id);
            if (!span) continue;
            const hold = Math.min(12, beat.end - before.end);
            if (!(hold > 0)) continue;
            span.holdAfterSeconds = Math.round(Math.max(Number(span.holdAfterSeconds) || 0, hold) * 1000) / 1000;
        }
        return value;
    };
    const acceptStory = draft => {
        enforceSpeedHints(draft);
        // A hard cut is an operator decision, not a story-model one: the model tends
        // to "complete" the topic by restoring the tail, so enforce the ending here.
        if (cutAfterSeconds !== null) {
            if (protectedSpans.some(span => span.end > cutAfterSeconds + .001)) {
                throw new Error('Operator cut-after would drop protected story evidence');
            }
            const dropped = timelineTools.truncateStoryKeep(draft, sourceCues, cutAfterSeconds);
            history.push({ stage: 'operator_cut_after', cutAfter: cutAfterSeconds, cutAfterAbsolute,
                droppedKeepSpans: dropped, keepSpans: draft.keep.length, lastCue: draft.keep.at(-1)?.toCue });
        }
        // A keep-tail decree is also operator-owned: the model tends to re-trim the
        // restored ending, so force full cue coverage from the declared point onward.
        // It runs before the keep beats so a restored span can carry the beat hold.
        if (keepTailSeconds !== null) {
            const inserted = timelineTools.forceKeepCueTail(draft, sourceCues, keepTailSeconds);
            history.push({ stage: 'operator_keep_tail', keepTailFrom: keepTailSeconds, keepTailFromAbsolute: keepTailAbsolute,
                insertedKeepSpans: inserted, keepSpans: draft.keep.length });
        }
        enforceKeepBeats(draft);
        profile = editorialProfile(draft.profile, { legacy: Boolean(options.creativeResumeDirectory && logs.at(-1)?.status === 'reused_draft') });
        updateProfile(profile);
        const timeline = timelineTools.validateStoryPlan(draft, sourceCues, sourceDuration, protectedSpans, profile,
            cutAfterSeconds !== null ? 0 : 3);
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
        + 'keep.speed表示该段过程性画面与原声同步加速而非删除：核对被加速的是无信息量的走路、找路或重复刷怪，且笑点、反转、反应与收束没有被加速吞掉。2.5倍以上段落的原字幕按设计不上屏、由画面角标标注倍率与时长，这不算字幕缺失；2.5倍以下的加速段仍须字幕可读。'
        + 'speedHints是运营已确认的加速区间：程序会在本审核之后把指定倍速叠加到对应keep段上，因此这些keep段没有speed字段是设计如此；审核只须确认这些区间被完整保留（未被删除、未被改短），不要因「timeline上没有speed字段」或「加速不够激进」而拒绝，加速倍率与位置由运营负责。'
        + 'protectedCoverage给出程序已验证的覆盖结果及保留字幕编号；请核对具体原话与内容含义，不凭时间猜测不存在的漏句。'
        + 'surroundingSpeech包含素材窗口之外的真实前后文（时间可为负数或大于sourceDuration）。核对后面是否还有同一话题的第二例、反转、追问、自纠或结论；若原窗口截断本题，拒绝并报告需扩展素材，不能只凭片内通顺通过。'
        + '扩窗新增内容若否定此前结论或澄清人物归属，须对照copy逐项核查；不能仅凭旧引用仍保留就认定旧文案正确。新增素材中无关话题可不保留，收束当前主题即可。'
        + '只返回 {"approved":true,"needsSourceExpansion":false,"issues":[]}。有歪曲、断句、丢失必要上下文时approved=false并指出具体位置。'
        + 'sourceDuration是全部可用素材的长度，不是timeline.duration成片长度；original的C字幕是当前素材里所有可用句子，kept仅是成片。必要原话在original或0–sourceDuration内时只需修keep，needsSourceExpansion=false；只有真实R字幕在素材窗之外才为true。可用requiredSourceCueIds列需要补入的真实R编号。\n'
        + (cutAfterSeconds !== null ? `运营已明确指定在本片 ${cutAfterSeconds.toFixed(2)}s 硬切收尾：其后的原话属于用户看过成片后明确授权整段删除的重复演示（同一个梗已经讲完），不构成丢失必要上下文或断句，不得因此拒绝、不得要求补齐，也不要置needsSourceExpansion=true。只核对收尾点之前的内容是否连贯。copy里的标题与封面文案是原始素材的文案依据，不是本轮成片必须逐条覆盖的内容清单；标题提到的原话落在收尾点之后属于运营硬切后的预期结果，不得据此拒绝、要求扩窗或要求恢复后段，标题文案由运营另行负责。\n` : '')
        + (keepTailSeconds !== null ? `运营已明确指定尾段从本片 ${keepTailSeconds.toFixed(2)}s 起强制保留到素材末尾（keepTailFrom）：素材窗的结尾就是成片的结尾，这是用户看过素材后确认的结构，碰铃铛之后的全部台词一句不删、只删纯静音空档。素材窗之后即使还有同话题原话，也不构成"窗口截断本题"，不得因此拒绝、不得置needsSourceExpansion=true、不得要求扩窗。只核对尾段内部的台词完整与连贯。\n` : '')
        + (keepBeatSeconds.length ? `运营指定的无台词表演区间（keepBeats）：${JSON.stringify(keepBeatSeconds.map(row => `${row.start.toFixed(2)}-${row.end.toFixed(2)}`))}。区间里是岁己的笑、叹气等真实反应，保留它们是运营明确要求，不属于"留了无信息量空档"，不得据此拒绝或要求删掉；这些区间没有字幕编号是设计如此。\n` : '')
        + (options.creativeNoStorySpeed ? '除了运营指定的speedHints区间，其余keep段没有speed字段是设计如此：后半段一律1x原速播放，不得因"节奏还能更快"而拒绝。\n' : '')
        + JSON.stringify({ profile, ...reviewEvidence, surroundingSpeech, topicEditPlan: clip.topicEditPlan || null, protectedSpans, protectedCues, speedHints, keepBeatSeconds, copy: baseline.copy }));
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
    if (profile.music === 'playful' && limits.music !== false) { const music = require('./creative_music').createPlayfulMusic(scratch); assets[music.id] = music; }
    Object.assign(limits, creativeSettings({ ...creativeOptions, editorialDensity: profile.density }));
    if (profile.tone !== 'comic') limits.variety = false;
    writeJsonAtomic(path.join(scratch, 'story-plan.json'), { timeline, protectedSpans, protectedCues, sourceCues, storyQa });
    console.log(`CREATIVE_STORY: ${sourceDuration.toFixed(2)}s -> ${duration.toFixed(2)}s (${timeline.keep.length} ranges)`);
    return { profile, timeline, duration, speech, audience, renderSrt };
}

module.exports = { runCreativeStory };
