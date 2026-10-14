/** Acoustic similarity is a candidate, not a verified public speaker identity. */
export function publicSpeakerIdentity(evidence: any): string | null {
    return evidence?.status === 'row_supported' && evidence.identityVerified === true
        && typeof evidence.label === 'string' && evidence.label.trim() ? evidence.label : null;
}

export const SPEAKER_IDENTITY_RULE = '声纹相似度、row_supported、accepted和名单均不能单独证明实名说话人。speakerEvidence.identityVerified只有严格为true才可单独作为声纹署名依据；false或缺失均为候选。原始label/bestLabel只供排查，不能把它写入标题、简介、封面或作为相邻语句主语。独立的片内明确身份/对话证据可以另行核验；提到某人不等于某人发言，房主也不能自动补作说话人。身份未知时保留原话或中性事件，不影响内容完整性。';

/** Reject copy names imported solely from unverified voice candidates, even without a registry. */
export function voiceOnlyCopyIssues(copy: Record<string, unknown>, cues: any[], people: any[] = [], sourceHost?: string): string[] {
    let description = String(copy.description || '');
    if (sourceHost) {
        const host = sourceHost.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // This generated source receipt identifies the recording, never a speaker of the story.
        const prefix = new RegExp('^来自 ' + host + ' 的直播《[^\\r\\n]+》，录制时间 \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}。\\r?\\n'
            + '片段时间 \\d{2,}:\\d{2}:\\d{2}-\\d{2,}:\\d{2}:\\d{2}。(?:\\r?\\n情绪：[^\\r\\n]+)?\\r?\\n\\r?\\n', 'u');
        description = description.replace(prefix, '');
    }
    const claims: Record<string, unknown> = { ...copy, description };
    const items = cues.flatMap(cue => cue.items?.length ? cue.items.map((item: any) => ({ ...item,
        text: item.text ?? (cue.items.length === 1 ? cue.text : '') })) : [cue]);
    const candidates = new Set<string>();
    const verified = new Set<string>();
    for (const item of items) {
        const evidence = item.speakerEvidence;
        const label = publicSpeakerIdentity(evidence);
        if (label) verified.add(label);
        else if (typeof evidence?.label === 'string' && evidence.label) candidates.add(evidence.label);
    }
    const contains = (text: string, name: string) => {
        const escaped = name.normalize('NFKC').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp((/^[a-z0-9_]/iu.test(name) ? '(?<![a-z0-9_])' : '') + escaped
            + (/[a-z0-9_]$/iu.test(name) ? '(?![a-z0-9_])' : ''), 'iu').test(text.normalize('NFKC'));
    };
    const speech = items.map(item => String(item.text || '').replace(/^(?:\s*\[[^\]\n]+\])+\s*/u, '')).join('\n');
    const issues: string[] = [];
    for (const label of candidates) {
        const person = people.find(person => [person.label, ...(person.names || [])].includes(label));
        const names = [...new Set([label, ...(person?.names || []), ...(label.match(/^([\p{Script=Han}]{2,})[A-Za-z]/u)?.slice(1) || [])])].filter(name => name.length > 1);
        if ([...verified].some(value => names.includes(value)) || names.some(name => contains(speech, name))) continue;
        for (const field of ['title', 'description', 'coverText']) {
            if (names.some(name => contains(String(claims[field] || ''), name))) issues.push(`unverified_voice_person:${field}:${label}`);
        }
    }
    return issues;
}
