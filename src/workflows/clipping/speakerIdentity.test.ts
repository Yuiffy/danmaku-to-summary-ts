import { publicSpeakerIdentity, voiceOnlyCopyIssues } from './speakerIdentity';

const voice = (identityVerified?: unknown) => ({ status: 'row_supported', label: '灰泽满Hazel', identityVerified,
    observations: [{ label: '灰泽满Hazel', scope: 'row', row: { accepted: true, score: .99 } }] });
const cues = (identityVerified?: unknown, text = '这意思是就否定了小女友？') => [{ start: 0, end: 4,
    items: [{ text, speakerEvidence: voice(identityVerified) }] }];

test.each([false, undefined, 'true', 1])('candidate %s never establishes a public speaker', value => {
    expect(publicSpeakerIdentity(voice(value))).toBeNull();
    expect(voiceOnlyCopyIssues({ title: '灰泽满追问：否定了小女友？' }, cues(value)))
        .toEqual(['unverified_voice_person:title:灰泽满Hazel']);
});
test('confirmed local identity and explicit mentions remain separate from candidate guesses', () => {
    expect(publicSpeakerIdentity(voice(true))).toBe('灰泽满Hazel');
    expect(publicSpeakerIdentity({ ...voice(true), status: 'mixed' })).toBeNull();
    expect(voiceOnlyCopyIssues({ title: '灰泽满追问' }, cues(true))).toEqual([]);
    expect(voiceOnlyCopyIssues({ title: '聊到灰泽满' }, cues(false, '昨天看到灰泽满的视频'))).toEqual([]);
    expect(voiceOnlyCopyIssues({ title: '这意思是否定了小女友？' }, cues(false))).toEqual([]);
});
test('aliases use configured names and do not borrow evidence from speaker prefixes', () => {
    const people = [{ label: '灰泽满Hazel', names: ['满满', '灰泽满Hazel'] }];
    expect(voiceOnlyCopyIssues({ description: '满满追问' }, cues(false, '[灰泽满Hazel] 这意思是？'), people))
        .toEqual(['unverified_voice_person:description:灰泽满Hazel']);
});

test('an exact source-host receipt is provenance, while named story actions and another host remain checked', () => {
    const prefix = '来自 灰泽满Hazel 的直播《日常聊天》，录制时间 2026-10-14 23:20:22。\n片段时间 00:27:21-00:28:22。\n\n';
    expect(voiceOnlyCopyIssues({ description: prefix + '聊到一个问题。' }, cues(false), [], '灰泽满Hazel')).toEqual([]);
    expect(voiceOnlyCopyIssues({ description: prefix + '灰泽满追问这个问题。' }, cues(false), [], '灰泽满Hazel'))
        .toEqual(['unverified_voice_person:description:灰泽满Hazel']);
    expect(voiceOnlyCopyIssues({ description: prefix + '聊到一个问题。' }, cues(false), [], '其他房主'))
        .toEqual(['unverified_voice_person:description:灰泽满Hazel']);
    expect(voiceOnlyCopyIssues({ title: '灰泽满提问', description: prefix + '聊到一个问题。' }, cues(false), [], '灰泽满Hazel'))
        .toEqual(['unverified_voice_person:title:灰泽满Hazel']);
});
