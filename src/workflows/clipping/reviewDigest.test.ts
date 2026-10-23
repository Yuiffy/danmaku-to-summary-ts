import { compactReviewLines, shortReviewReasons, withReviewExcerpts, deferredReviewLines, compactDiagnosticLines, reviewAttentionLines } from './reviewDigest';

test('notification and local review retain all optional topics in numeric order including low scores and restored entries', () => {
    const decisions = Array.from({ length: 20 }, (_, i) => ({ index: i + 1, start: i * 100, end: i * 100 + 30,
        selected: false, score: 60 + i, title: `备选话题${i + 1}`, reason: 'below_score' }));
    const metadata = { source: { mediaPath: 'stream', srtPath: 'source' }, reviewPath: 'D:/review/REVIEW.md',
        publication: { policy: { mode: 'curated' }, decisions: [...decisions].reverse() },
        aiStatus: { ranking: { skipped: [12, 2, 1].map(candidateIndex => ({ candidateIndex, score: 30, title: '初选备选', start: 100 - candidateIndex, end: 150 })) } },
        deferredResolutions: [{ selectionKey: 'P:stream:source:20:1900:1930', clipId: 900 }] };
    const before = JSON.stringify(metadata);
    const compact = deferredReviewLines(metadata, [], { compact: true }).join('\n');
    expect(compact.match(/^- P\d+ /gmu)).toHaveLength(20);
    expect(compact).toContain('共23条，按编号排列');
    expect(compact).toContain('- P20 |');
    expect(compact).toContain('- P1 |');
    const labels = [...compact.matchAll(/^- ([PR]\d+) \|/gmu)].map(match => match[1]);
    expect(labels).toEqual([...decisions.map(row => `P${row.index}`), 'R1', 'R2', 'R12']);
    expect(compact).toContain('D:/review/REVIEW.md');
    const full = deferredReviewLines(metadata).join('\n');
    expect(full.match(/^- P\d+ /gmu)).toHaveLength(20);
    expect(full).toContain('已补切ID900');
    expect(compact).toContain('已补切ID900');
    expect(JSON.stringify(metadata)).toBe(before);
});

test('attention index distinguishes active review, transport failures and optional rejected items', () => {
    const text = reviewAttentionLines([{ id: 1, status: '已投稿' }, { id: 2, status: '已排队投稿' },
        { id: 3, status: '待人工复核' }, { id: 4, status: '已剔除（未切）', rejected: true },
        { id: 5, status: '投稿失败' }, { id: 6, status: '重复已跳过' }, { id: 7, status: '已投稿（当前资料待复核）' }]).join('\n');
    expect(text).toContain('ID3：待人工复核');
    expect(text).toContain('ID5：投稿失败');
    expect(text).toContain('ID7：已投稿资料有变动');
    for (const id of [1, 2, 4, 6]) expect(text).not.toContain(`ID${id}：`);
    expect(reviewAttentionLines([{ status: '待人工复核' }]).join('\n')).toContain('编号待登记');
});

test('fatal batch errors never report an empty or fully queued list as requiring no action', () => {
    expect(reviewAttentionLines([])).toEqual(['本次无需人工处理成片；备选仅供按兴趣补切。']);
    for (const rows of [[], [{ id: 1, status: '已排队投稿' }]]) {
        const text = reviewAttentionLines(rows, { fatalError: 'planning failed' }).join('\n');
        expect(text).toContain('需先排查批次错误');
        expect(text).not.toContain('无需人工处理');
    }
    expect(reviewAttentionLines([{ id: 3, status: '待人工复核' }], { fatalError: 'planning failed' }).join('\n'))
        .toContain('ID3：待人工复核');
});

test('fatal diagnostics retain ranked selection counts ahead of other warnings', () => {
    const error = 'Invalid ranked selection size: selected=58, maxClips=50';
    const metadata = { fatalError: error, aiStatus: { errors: [1, 2, 3, 4].map(index => `选材分块${index}失败`) } };
    const lines = compactDiagnosticLines(metadata);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('批次处理：候选排序结果数量不合法');
    expect(lines[0]).toContain(error);
});

test('fatal diagnostic detail is bounded and strips credentials and stack lines', () => {
    const detail = compactDiagnosticLines({ fatalError: new Error('planning failed at https://user:pass@example.test/api?key=secret-value Authorization: Bearer access-secret api_key=key-secret token=token-secret sk-provider-secret "password": "quoted secret" Basic encoded-secret\n at private-stack') }).join('\n');
    expect(detail).toContain('原始错误：planning failed');
    for (const secret of ['user:pass', 'secret-value', 'access-secret', 'key-secret', 'token-secret', 'sk-provider-secret', 'quoted secret', 'encoded-secret', 'private-stack']) {
        expect(detail).not.toContain(secret);
    }
    expect(compactDiagnosticLines({ fatalError: 'x'.repeat(1000) })[0].length).toBeLessThan(250);
});

test('short reasons retain the concrete blocker and omit duplicate codes and passing observations', () => {
    const issues = ['字幕“没有这种被凶的预气”中“预气”疑为错字；需核实并修正，现有证据不足以确认音频原词。',
        'final_subtitles_not_passed', '本地音频引文和画面支持这是一段连续的电影同看活动。'];
    expect(shortReviewReasons(issues)).toEqual(['字幕“没有这种被凶的预气”中“预气”疑为错字']);
    expect(shortReviewReasons(['source_window_incomplete'])).toEqual(['片段结尾或上下文不完整']);
    expect(shortReviewReasons(['中文原因'.repeat(100)])[0].length).toBeLessThanOrEqual(80);
    expect(shortReviewReasons(['final publication review has not passed every required check', 'source_window_incomplete',
        'required review flag removed: attributionRequired'])).toEqual(['片段结尾或上下文不完整', '来源复核条件有变化，需重新审核']);
    expect(shortReviewReasons(['字幕“预气”疑为错字', 'final publication review has not passed every required check']))
        .toEqual(['字幕“预气”疑为错字']);
});

test('Chinese summaries cover mixed-language reasons and batch errors while preserving original SRT', () => {
    const issue = '字幕多处明显错识，如“had they do with”，无法理解；需核对ASR';
    const lines = compactReviewLines({ reviewExcerpt: { subtitles: [{ start: 10, end: 13, text: 'had they do with' }] } }, [issue]);
    expect(lines[0]).toBe('   理由: 字幕多处明显错识，如“had they do with”，无法理解');
    expect(lines[1]).toContain('“had they do with”');
    const diagnostics = compactDiagnosticLines({ aiStatus: { attribution: { events: [{ phase: 'actor-review', error: 'request_budget_exhausted' }] },
        requests: [{ phase: 'selection', status: 'failure', error: 'Selection transport failed' }] },
        automaticPublication: { error: 'required review flag removed: attributionRequired' } }).join('\n');
    expect(diagnostics).toContain('本轮审核额度已用完');
    expect(diagnostics).toContain('审核服务连接失败');
    expect(diagnostics).toContain('来源复核条件有变化');
    expect(diagnostics).not.toMatch(/[a-z]{2,}/iu);
    expect(shortReviewReasons(['automatic submission outcome unknown', 'automatic publication source identity changed']))
        .toEqual(['旧投稿结果未确认，需核对线上稿件', '本次修订需更新投稿授权']);
});

test('deferred topics keep ranking IDs, scores, times and short reasons without inventing upload IDs',()=>{
    const data={aiStatus:{ranking:{skipped:[{candidateIndex:8,start:100,end:150,score:65,title:'初选话题',reason:'看点偏弱'}]}},
        publication:{policy:{mode:'curated'},decisions:[{index:3,selected:false,start:200,end:250,score:77,title:'备选话题',reason:'below_score'},
            {index:4,selected:true,start:300,end:350,score:95,title:'已入选话题'}]}};
    const before=JSON.stringify(data),text=deferredReviewLines(data).join('\n');
    expect(text).toContain('R8 | 1:40–2:30 | 65分 | 初选话题 | 看点偏弱');
    expect(text).toContain('P3 | 3:20–4:10 | 77分 | 备选话题 | 低于分数线');
    expect(text).not.toContain('已入选话题');expect(text).toContain('均不是上传ID');
    expect(JSON.stringify(data)).toBe(before);
});

test('review excerpts select the suspect SRT line and nearby viewer text without attributing chat to the host', () => {
    const row = { window: { start: 100, end: 200 }, uploadReady: false, publicationReview: { status: 'needs_review' },
        reviewExcerpt: { subtitles: [{start:101,end:103,text:'开场白'}, {start:150,end:155,text:'没有这种被凶的预气'}],
            audience:[{time:110,text:'开场弹幕'}, {time:151,text:'这里是不是预期？'}, {time:250,text:'范围外'}] } };
    const original = JSON.stringify(row);
    const lines = compactReviewLines(row,['字幕“预气”疑为错字']).join('\n');
    expect(lines).toContain('SRT: 录播2:30 “没有这种被凶的预气”');
    expect(lines).toContain('弹幕（观众）: 录播2:31 “这里是不是预期？”');
    expect(lines).not.toContain('范围外');
    expect(JSON.stringify(row)).toBe(original);
    expect(row.uploadReady).toBe(false);
});

test('foreign detector hints identify the actual time and words instead of implying a proven error', () => {
    const row = { subtitleProofreading: { reviewGroups: [{ type: 'possible_foreign_audio', occurrences: [
        { start: 110, text: 'foreign words' }, { start: 110.001, text: 'foreign words' }] }] } };
    const text = compactReviewLines(row, ['subtitle_review_groups_pending']).join('\n');
    expect(text).toContain('尚未证明有错');
    expect(text).toContain('录播1:50“foreign words”');
    expect(text.match(/foreign words/gu)).toHaveLength(1);
    expect(text).toContain('独立复核是否影响主线');
});

test('current rendered SRT uses local time, source SRT uses absolute time and XML reads are shared per list', async () => {
    const audience = jest.fn(async()=>[{time:115,text:'同一份XML'}, {time:900,text:'窗外'}]);
    const readers = { exists: (file:string)=>file!=='missing', audience,
        subtitles: (file:string)=>file==='rendered' ? [{start:15,end:18,text:'成片词'}]
            : [{start:115,end:118,text:'源字幕词'}] };
    const rows = [{window:{start:100,end:200},source:{srtPath:'source',xmlPath:'chat'},output:{srtPath:'rendered'}},
        {window:{start:100,end:200},source:{srtPath:'source',xmlPath:'chat'},output:{srtPath:'missing'}}];
    const before = JSON.stringify(rows);
    const result = await withReviewExcerpts(rows,readers);
    expect(result[0].reviewExcerpt.subtitles).toEqual([{start:115,end:118,text:'成片词'}]);
    expect(result[1].reviewExcerpt.subtitles).toEqual([{start:115,end:118,text:'源字幕词'}]);
    expect(result[0].reviewExcerpt.audience).toEqual([{time:115,text:'同一份XML'}]);
    expect(audience).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(rows)).toBe(before);
});

test('unresolved recall windows show stored speech without borrowing subtitles or chat at uncertain times', async () => {
    const readers = { exists: jest.fn(() => true), subtitles: jest.fn(() => [{ start: 100, end: 105, text: '错误时间的别的话题' }]),
        audience: jest.fn(async () => [{ time: 100, text: '无关弹幕' }]) };
    const original = { window: { start: 100, end: 150 }, source: { srtPath: 'old.srt', xmlPath: 'chat.xml' },
        selectionRejection: { reason: 'topic_boundary_incomplete' }, publicCopyPending: true, uploadReady: false,
        reviewPresentation: { title: '吐槽反派讲自己的计划', windowAuthority: 'recall_context', recallSubtitles: [
            { id: 'G1', text: '这搞笑你知道吗' }, { id: 'G2', text: '背景对白和转场' },
            { id: 'G8', text: '反派为什么要讲自己的计划' }] } };
    const before = JSON.stringify(original), [row] = await withReviewExcerpts([original], readers);
    const text = compactReviewLines(row, ['话题边界未闭合']).join('\n');
    expect(text).toContain('SRT（原召回，时间待校准）: “反派为什么要讲自己的计划”');
    expect(text).toContain('弹幕: 范围待校准，暂不引用');
    expect(text).not.toContain('录播');
    expect(text).not.toContain('错误时间');
    expect(text).not.toContain('背景对白和转场');
    expect(readers.exists).not.toHaveBeenCalled();
    expect(readers.subtitles).not.toHaveBeenCalled();
    expect(readers.audience).not.toHaveBeenCalled();
    expect(row.uploadReady).toBe(false);
    expect(JSON.stringify(original)).toBe(before);
});

test('activity package excerpts keep source evidence when there is no single clip window', () => {
    const lines = compactReviewLines({ reviewExcerpt: {
        subtitles: [{ id: 'T8', start: 14200, end: 14204, text: '直接复联三呀也可以的呀' }],
        audience: [{ time: 14202, text: '今天还看吗' }]
    } }, ['视听结束点需要核查后续原话']).join('\n');
    expect(lines).toContain('T8 “直接复联三呀也可以的呀”');
    expect(lines).toContain('弹幕（观众）: 录播236:42 “今天还看吗”');
});

test('a proposed edit and an abandoned precision attempt retain source times and nearby audience evidence', async () => {
    const readers = { exists: () => true, subtitles: () => [{ start: 130, end: 134, text: '没有这种被凶的预气' }],
        audience: async () => [{ time: 101, text: '无关开场'}, { time: 232, text: '这里是不是预期' }] };
    const [row] = await withReviewExcerpts([{ window: { start: 100, end: 250 }, source: { xmlPath: 'chat' },
        output: { srtPath: 'rendered' }, topicEditPlan: { ranges: [] }, creativeResult: { status: 'kept_original' } }], readers);
    const lines = compactReviewLines(row, ['字幕“预气”疑为错字']).join('\n');
    expect(lines).toContain('SRT: 录播3:50');
    expect(lines).toContain('这里是不是预期');
    expect(lines).not.toContain('无关开场');
    const [edited] = await withReviewExcerpts([{ window: { start: 100, end: 250 }, output: { srtPath: 'rendered' },
        editPlan: { keep: [] } }], readers);
    expect(edited.reviewExcerpt.subtitles[0].timeBasis).toBe('clip_seconds');
});
