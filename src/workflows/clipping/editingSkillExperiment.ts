/** Shadow-only editorial guidance. No runtime configuration or publication authority. */
export const EDITING_SKILL_VERSION = 'story-beats-v1';
export const EDITING_SKILL_SOURCES = [
    '.agents/skills/happy-sui-series/SKILL.md#选材与节奏',
    '.agents/skills/sui-clip-queue/references/precision-editing.md#如何判断与剪辑'
];

export function editingSkillPrompt(baselinePrompt: string, variant: 'baseline' | 'story_beats'): string {
    if (!baselinePrompt.trim()) throw new Error('Missing frozen baseline prompt');
    if (variant === 'baseline') return baselinePrompt;
    if (variant !== 'story_beats') throw new Error('Unknown editing skill variant');
    return baselinePrompt + '\n\n剪辑技能实验 ' + EDITING_SKILL_VERSION + '：\n' + [
        '先在内部建立每个看点的“前提/目标→行动或发言→结果/反转→反应/收束”链，再给出原有格式的keep。不是每段都必须搞笑；缺少某一拍不能编造。',
        '把完整句组当编辑单位。字幕条可能只是半个词或半句话；相邻条共同组成的句子不可仅因cue编号不同就拆开。保留指代来源、否定、条件、问题与回答。',
        '重复尝试优先保留首次建立目标、真正升级或改变、最终结果及对应反应；同样失败但没有新信息的尝试可删。只凭字幕不能断言游戏胜负、死亡、画面操作或人物身份。',
        '每个保留组的reason说明它给观众新增了什么或连接哪两拍。按原顺序保留，禁止用后果伪造前因。',
        '原地等待、找菜单、调设备只在影响后续理解时保留；段落之间必须让观众知道目标为何改变，收束后不要顺带接入无关新话题。',
        '删短和切得碎不是目标，原片已经紧凑可以保留。已有protectedSpans/protectedCues和话题keep/drop是硬约束，不得为实验删掉；整段受保护时承认没有删减空间。',
        '保持内容类型与语气：教学保留必要步骤和解释；连续表演保留乐句，不加喜剧音乐/笑声。当前阶段不添加特效或修改文案，新增音画判断留给原画与原音审核。',
        '只返回原要求的JSON结构，不增加字幕、角色、事件或时间。'
    ].join('\n');
}

export interface EditingCue { id: string; start: number; end: number; text: string }
export interface EditingRange { start: number; end: number }
export interface EditingReference {
    /** Withheld from generation. A complete primary or alternative group establishes the beat. */
    requiredBeats: Array<{ label: string; cueIds: string[]; alternativeCueIds?: string[][] }>;
    redundantCueIds: string[];
}
export interface EditingSample {
    id: string; sessionId: string; split: 'screening' | 'holdout';
    duration: number; cues: EditingCue[]; reference: EditingReference;
}

export function validateEditingSamples(samples: EditingSample[]): void {
    if (!Array.isArray(samples) || !samples.length) throw new Error('Missing editing samples');
    const ids = new Set<string>(), sessions = new Map<string, string>();
    for (const s of samples) {
        if (!s.id || ids.has(s.id) || !s.sessionId || !['screening', 'holdout'].includes(s.split)
            || !Number.isFinite(s.duration) || s.duration <= 0 || !s.cues?.length) throw new Error('Invalid editing sample');
        if (sessions.has(s.sessionId) && sessions.get(s.sessionId) !== s.split) throw new Error('Session leakage across splits');
        ids.add(s.id); sessions.set(s.sessionId, s.split);
        const cueIds = new Set<string>();
        for (const [i, cue] of s.cues.entries()) {
            if (!cue.id || cueIds.has(cue.id) || typeof cue.text !== 'string'
                || !Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < 0
                || cue.end <= cue.start || cue.end > s.duration + .002
                || i > 0 && cue.start < s.cues[i - 1].start) throw new Error('Invalid editing cues');
            cueIds.add(cue.id);
        }
        if (!s.reference || !Array.isArray(s.reference.requiredBeats) || !Array.isArray(s.reference.redundantCueIds)) throw new Error('Missing withheld reference');
        const required = s.reference.requiredBeats.flatMap(b => {
            if (!b.label || !Array.isArray(b.cueIds) || !b.cueIds.length) throw new Error('Invalid beat reference');
            if (b.alternativeCueIds !== undefined && (!Array.isArray(b.alternativeCueIds)
                || b.alternativeCueIds.some(group => !Array.isArray(group) || !group.length))) throw new Error('Invalid alternative beat reference');
            return [b.cueIds, ...(b.alternativeCueIds || [])].flat();
        });
        if ([...required, ...s.reference.redundantCueIds].some(id => !cueIds.has(id))) throw new Error('Unknown reference cue');
        if (s.reference.redundantCueIds.some(id => required.includes(id))) throw new Error('Contradictory reference cue');
    }
}

/** Descriptive metrics only; a shorter timeline or larger score is not media approval. */
export function measureEditingTimeline(sample: EditingSample, keep: EditingRange[]) {
    validateEditingSamples([sample]);
    if (!Array.isArray(keep) || !keep.length || keep.some((s, i) => !Number.isFinite(s.start) || !Number.isFinite(s.end)
        || s.start < 0 || s.end <= s.start || s.end > sample.duration + .002 || i > 0 && s.start < keep[i - 1].end - .001)) {
        throw new Error('Invalid evaluation timeline');
    }
    const retained = new Set(sample.cues.filter(c => keep.some(r => c.start >= r.start - .002 && c.end <= r.end + .002)).map(c => c.id));
    const truncated = sample.cues.filter(c => keep.some(r => c.start < r.end - .002 && c.end > r.start + .002) && !retained.has(c.id));
    if (truncated.length) throw new Error('Evaluation timeline truncates cues: ' + truncated.map(c => c.id).join(', '));
    const missingBeats = sample.reference.requiredBeats.filter(b =>
        ![b.cueIds, ...(b.alternativeCueIds || [])].some(group => group.every(id => retained.has(id)))).map(b => b.label);
    const redundantRetained = sample.reference.redundantCueIds.filter(id => retained.has(id));
    const seconds = keep.reduce((n, s) => n + s.end - s.start, 0);
    return { retainedCueIds: [...retained], duration: Math.round(seconds * 1000) / 1000, cuts: keep.length - 1,
        requiredBeatCount: sample.reference.requiredBeats.length,
        completeBeatCount: sample.reference.requiredBeats.length - missingBeats.length, missingBeats,
        redundantCueCount: sample.reference.redundantCueIds.length, redundantRetained,
        mediaReviewed: false, publicationApproved: false };
}
