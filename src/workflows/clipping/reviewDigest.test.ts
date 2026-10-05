import { compactReviewLines, shortReviewReasons, withReviewExcerpts, deferredReviewLines, compactDiagnosticLines } from './reviewDigest';

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
    expect(lines[0]).toBe('   理由: 字幕含疑似乱码或错词，需核对原音');
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
