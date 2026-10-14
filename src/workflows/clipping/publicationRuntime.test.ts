import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { Artifact } from './enhancement';
import { reviewOwnPublications, enqueueOwnPublications, reviewPublications, enqueuePublications, publicationFrameTimes, inspectPublicationMedia, PublicationContext, PublicationAdapters } from './publicationRuntime';

const passed = { status: 'passed', checks: { content: true, attribution: true, subtitles: true, visuals: true, policy: true }, issues: [] };
const picture = 'data:image/jpeg;base64,/9j/';
test('current versioned captions receive bounded final-frame evidence without using stale or out-of-range edits', () => {
    const subtitles = Array.from({length: 8}, (_, index) => ({start:index*10+1,end:index*10+5,text:`当前${index}`}));
    const artifact: Artifact = {window:{start:100,end:180,duration:80},copy:{title:'标题',description:'简介',coverText:'封面'},output:{}};
    const baseline = publicationFrameTimes(artifact,subtitles,80);
    artifact.renderedSubtitles={revision:2,renderedRevision:2,edits:[{changes:[
        {cue:2,after:'当前1'}, {cue:3,after:'已不在当前字幕'}, {cue:0,after:'当前7'},
        {cue:4,after:'当前3'}, {cue:5,after:'当前4'}, {cue:6,after:'当前5'}, {cue:9,after:'窗外'}
    ]}]};
    const times=publicationFrameTimes(artifact,subtitles,80);
    expect(times).toEqual([...baseline,34.9,44.9,54.9]);
    expect(times).not.toContain(24.9);
    expect(times.length).toBeLessThanOrEqual(8);
    artifact.renderedSubtitles.renderedRevision=1;
    expect(publicationFrameTimes(artifact,subtitles,80)).toEqual(baseline);
});

function fixture() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-runtime-'));
    const source = { mediaPath: path.join(directory, 'source.mp4'), srtPath: path.join(directory, 'source.srt'), xmlPath: path.join(directory, 'source.xml') };
    fs.writeFileSync(source.mediaPath, 'source video');
    fs.writeFileSync(source.srtPath, '完整原话'); fs.writeFileSync(source.xmlPath, '原始弹幕');
    const artifact = (index: number): Artifact => {
        const output = { metadataPath: path.join(directory, `clip-${index}.json`), mediaPath: path.join(directory, `clip-${index}.mp4`),
            srtPath: path.join(directory, `clip-${index}.srt`), coverPath: path.join(directory, `clip-${index}.jpg`), burnedSubtitles: true };
        for (const key of ['mediaPath', 'srtPath', 'coverPath'] as const) fs.writeFileSync(output[key], key === 'srtPath' ? '完整原话' : `${key}-${index}`);
        const value = { mode: 'own_stream_fun_review', generatedAt: '2026-10-03T01:00:00Z', roomId: '25788785',
            source, window: { index, start: 0, end: 20, duration: 20 }, uploadReady: true,
            copy: { title: `片段 ${index}`, description: '片内事实', coverText: '片内\n事实' }, output };
        fs.writeFileSync(output.metadataPath, JSON.stringify(value));
        return value;
    };
    const context: PublicationContext = { config: { mode: 'auto', roomIds: ['25788785'], policyVersion: 'own-stream-v1',
        activatedAt: '2026-10-03T00:00:00Z', authorizationNote: 'Authorized by fixture', concurrency: 2 },
        roomId: '25788785', streamerName: '岁己', excludedCategories: ['现实家庭关系'], aiEnabled: true, ffmpegPath: 'unused', ffprobePath: 'unused' };
    const adapters: PublicationAdapters = {
        parse: file => [{ start: 1, end: 15, text: fs.readFileSync(file, 'utf8') }],
        evidence: () => ({ sourceSha256: 'a'.repeat(64), cues: [{ id: 'G1', start: 1, end: 15, text: '完整原话' }] }),
        audience: async file => [{ time: 3, text: fs.readFileSync(file, 'utf8') }],
        now: () => '2026-10-03T02:00:00Z',
        inspect: async () => ({ passed: true, issues: [], frames: [picture, picture] }),
        withMedia: work => work(null), runFfmpeg: async () => { throw new Error('Unexpected media call'); },
        request: jest.fn(async () => ({ text: JSON.stringify(passed) }))
    };
    return { directory, source, artifact, context, adapters };
}

test('a voice-only named public claim is held before an AI pass can approve it', async () => {
    const f = fixture();
    try {
        const artifact = f.artifact(1);
        artifact.copy.title = '灰泽满追问：否定了小女友？';
        f.adapters.evidence = () => ({ sourceSha256: 'a'.repeat(64), cues: [{ id: 'G1', start: 1, end: 15,
            text: '这意思是否定了小女友？', items: [{ text: '这意思是否定了小女友？',
                speakerEvidence: { status: 'row_supported', label: '灰泽满Hazel', identityVerified: false } }] }] });
        const [result] = await reviewOwnPublications([artifact], f.context, f.adapters);
        expect(result.publicationDecision.action).toBe('needs_human');
        expect(result.publicationReview.issues).toContain('unverified_voice_person:title:灰泽满Hazel');
        expect(f.adapters.request).not.toHaveBeenCalled();
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('low-rate video with a longer audio tail samples current video frames and cannot reuse an old image', async () => {
    const f = fixture();
    try {
        const artifact = f.artifact(1);
        artifact.window.duration = 194.044;
        const subtitles = [{ start: 0, end: .884, text: '开头' }, { start: 177.594, end: 194.043, text: '结尾' }];
        const jpeg = Buffer.from([255, 216, 255]);
        fs.writeFileSync(artifact.output.coverPath, jpeg);
        f.adapters.probe = async () => ({ format: { duration: '194.044' }, streams: [
            { codec_type: 'video', width: 960, height: 540, start_time: '0', duration: '193.799', avg_frame_rate: '970000/193799' },
            { codec_type: 'audio', start_time: '0', duration: '194.044' }
        ] });
        const requested: number[] = [];
        f.adapters.runFfmpeg = async args => {
            if (!args.includes('-ss')) return;
            const time = Number(args[args.indexOf('-ss') + 1]);
            requested.push(time);
            // FFmpeg exits successfully without a file when seeking beyond the last frame's PTS.
            if (time <= 193.6) fs.writeFileSync(args.at(-1)!, jpeg);
        };
        const inspection = await inspectPublicationMedia(artifact, subtitles, f.context, f.adapters);
        expect(inspection.passed).toBe(true);
        expect(requested).toHaveLength(5);
        expect(requested.at(-1)).toBeCloseTo(193.549);
        expect(inspection.facts.sampledFrameTimes).toEqual(requested);
        expect(inspection.frames).toHaveLength(6);
        // A second extraction producing no output must not accept the previous inspection's frames.
        f.adapters.runFfmpeg = async () => undefined;
        await expect(inspectPublicationMedia(artifact, subtitles, f.context, f.adapters)).rejects.toThrow('ENOENT');
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('known Paraformer fallback timing blocks review and Python upload validation even when the old model passed', async () => {
    const f = fixture();
    try {
        const [passedArtifact] = await reviewOwnPublications([f.artifact(1)], f.context, f.adapters);
        fs.writeFileSync(f.source.srtPath.replace(/\.srt$/u, '.asr_meta.json'), JSON.stringify({ backend: 'paraformer',
            speakerProcessing: { intervalSource: 'sentence_info_fallback' } }));
        f.adapters.request = jest.fn();
        const [blocked] = await reviewOwnPublications([passedArtifact], f.context, f.adapters);
        expect(blocked.publicationDecision.action).toBe('needs_human');
        expect(blocked.publicationReview.issues.join('')).toContain('时间轴不可靠');
        expect(f.adapters.request).not.toHaveBeenCalled();
        const file = path.join(f.directory, 'old-review.json');
        fs.writeFileSync(file, JSON.stringify(passedArtifact));
        const python = spawnSync('python', ['-c',
            'import json,sys; from src.scripts.clip_auto_publication import validate_publication_review; validate_publication_review(json.load(open(sys.argv[1],encoding="utf-8")))', file],
        { encoding: 'utf8', windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' } });
        expect(python.status).not.toBe(0); expect(python.stderr).toContain('时间轴不可靠');
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('new final artifacts are reviewed independently; only passed stable IDs reach automatic enqueue', async () => {
    const f = fixture();
    try {
        f.adapters.request = jest.fn(async artifact => ({ text: JSON.stringify(artifact.copy.title.endsWith('1') ? passed
            : { ...passed, status: 'needs_review', checks: { ...passed.checks, content: false }, issues: ['结尾问题未讲完'] }) }));
        const result = await reviewOwnPublications([f.artifact(1), f.artifact(2)], f.context, f.adapters);
        expect(result.map(row => row.publicationDecision.action)).toEqual(['auto_queue', 'needs_human']);
        expect(JSON.parse(fs.readFileSync(result[1].output.metadataPath, 'utf8')).publicationReview.issues).toContain('结尾问题未讲完');
        const invoke = jest.fn(async () => 'AUTOMATIC_ENQUEUE_RESULT: {"queuedIds":[31],"results":[{"id":31,"status":"queued"}]}');
        const receipt = await enqueueOwnPublications(result, { clipIdsByReviewIndex: { 1: 31, 2: 42 } }, process.cwd(), invoke);
        expect(invoke).toHaveBeenCalledWith([31]); expect(receipt.queuedIds).toEqual([31]);
        const python = spawnSync('python', ['-c', 'import json,sys;from pathlib import Path;from src.scripts.clip_auto_publication import validate_publication_review;validate_publication_review(json.loads(Path(sys.argv[1]).read_text(encoding="utf-8")))', result[0].output.metadataPath],
            { cwd: process.cwd(), encoding: 'utf8', windowsHide: true, shell: false });
        expect(python.stderr).toBe(''); expect(python.status).toBe(0);
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('policy activation and explicit plan replay do not backfill old artifacts or contact a provider', async () => {
    const f = fixture();
    try {
        const old = f.artifact(1); old.generatedAt = '2026-10-02T23:59:59Z';
        expect((await reviewOwnPublications([old], f.context, f.adapters))[0]).toBe(old);
        const fresh = f.artifact(2);
        expect((await reviewOwnPublications([fresh], { ...f.context, planPath: 'replay.json' }, f.adapters))[0]).toBe(fresh);
        expect((await reviewOwnPublications([fresh], { ...f.context, config: { ...f.context.config, mode: 'off' } }, f.adapters))[0]).toBe(fresh);
        expect(f.adapters.request).not.toHaveBeenCalled();
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('reads current XML and complete source cue IDs under the source snapshot; mid-review edits stay pending', async () => {
    const f = fixture();
    try {
        fs.writeFileSync(f.source.xmlPath, '当前弹幕');
        f.adapters.request = jest.fn(async (_artifact, prompt) => {
            expect(prompt).toContain('当前弹幕'); expect(prompt).toContain('G1');
            fs.writeFileSync(f.source.xmlPath, '请求期间变化');
            return { text: JSON.stringify(passed) };
        });
        const [result] = await reviewOwnPublications([f.artifact(1)], f.context, f.adapters);
        expect(result.publicationDecision.action).toBe('needs_human');
        expect(result.publicationReview.issues).toContain('publication_evidence_changed_during_review');
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('final review includes bounded question/answer audience context with original IDs and no metadata writes in read-only mode', async () => {
    const f = fixture();
    try {
        const artifact = f.artifact(1);
        artifact.window = { start: 100, end: 120, duration: 20 };
        f.adapters.audience = async () => [
            { time: 60, text: '无关的旧话题' }, { time: 92, text: '栞神承认自己抄了岁己了' },
            { time: 110, text: '小岁' }, { time: 180, text: '后续上下文' }, { time: 181, text: '窗外评论' }
        ];
        f.adapters.parse = file => [{ start: file === f.source.srtPath ? 101 : 1,
            end: file === f.source.srtPath ? 115 : 15, text: '我把岁己抄了' }];
        const before = fs.readFileSync(artifact.output.metadataPath, 'utf8');
        const [result] = await reviewOwnPublications([artifact], { ...f.context, persist: false }, f.adapters);
        const prompt = (f.adapters.request as jest.Mock).mock.calls[0][1];
        const packet = JSON.parse(prompt.split('EVIDENCE_JSON ')[1]);
        expect(packet.sourceAudience).toEqual([
            { time: 92, text: '栞神承认自己抄了岁己了', id: 'D2' },
            { time: 110, text: '小岁', id: 'D3' }, { time: 180, text: '后续上下文', id: 'D4' }
        ]);
        expect(packet.sourceWindow).toEqual({ start: 100, end: 120, duration: 20 });
        expect(result.publicationDecision.action).toBe('auto_queue');
        expect(fs.readFileSync(artifact.output.metadataPath, 'utf8')).toBe(before);
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('preserves exact cue-to-row acoustic evidence while keeping an unverified match separate from public speaker identity', async () => {
    const f = fixture();
    try {
        const cue = { id: 'G1', start: 1, end: 15, text: '完整原话',
            items: [{ asrEvidence: { recognizedText: '完整原话' },
                speakerEvidence: { version: 1, status: 'row_supported', label: '岁己SUI', identityVerified: false,
                    observations: [{ row: { accepted: true, smoothed: false, score: .78, margin: .25, policy: 'row_verified' } }] } }] };
        f.adapters.evidence = () => ({ sourceSha256: 'a'.repeat(64), cues: [cue] });
        f.context.configuredPeople = [{ id: 'sui', label: '岁己SUI', names: ['岁己SUI', '小岁'] }];
        f.adapters.request = jest.fn(async (_artifact, prompt) => {
            const evidence = JSON.parse(prompt.split('EVIDENCE_JSON ')[1]);
            expect(evidence.evidence.cues).toEqual([cue]);
            expect(evidence.evidence.configuredPeople).toEqual(f.context.configuredPeople);
            expect(prompt).toContain('It only resolves names; it does not prove anyone spoke');
            expect(prompt).toContain('cue.items row');
            expect(prompt).toContain('this match cannot independently establish a named speaker');
            expect(prompt).toContain('Return resolvedGroundingIssues:[]');
            return { text: JSON.stringify(passed) };
        });
        const [result] = await reviewOwnPublications([f.artifact(1)], f.context, f.adapters);
        expect(result.publicationDecision.action).toBe('auto_queue');
        f.adapters.evidence = () => ({ sourceSha256: 'a'.repeat(64), cues: [{ ...cue,
            items: [{ asrEvidence: cue.items[0].asrEvidence, speakerEvidence: undefined }] }] });
        f.adapters.request = jest.fn(async () => ({ text: JSON.stringify({ ...passed, status: 'needs_review',
            checks: { ...passed.checks, attribution: false }, issues: ['本行没有人物声纹依据'] }) }));
        const [unknown] = await reviewOwnPublications([f.artifact(2)], f.context, f.adapters);
        expect(unknown.publicationDecision.action).toBe('needs_human');
        expect(unknown.publicationReview.issues).toContain('本行没有人物声纹依据');
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('disabled AI and missing media retain each candidate without preventing other reviews', async () => {
    const f = fixture();
    try {
        const broken = f.artifact(1), good = f.artifact(2); fs.unlinkSync(broken.output.mediaPath);
        const results = await reviewOwnPublications([broken, good], f.context, f.adapters);
        expect(results.map(row => row.publicationDecision.action)).toEqual(['needs_human', 'auto_queue']);
        const [disabled] = await reviewOwnPublications([good], { ...f.context, aiEnabled: false }, f.adapters);
        expect(disabled.publicationReview.status).toBe('unavailable');
        expect(f.adapters.request).toHaveBeenCalledTimes(1);
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('ambiguous enqueue completion is reported once without resubmission or pretending it was uploaded', async () => {
    const f = fixture();
    try {
        const [result] = await reviewOwnPublications([f.artifact(1)], f.context, f.adapters);
        const invoke = jest.fn(async () => { throw new Error('receipt lost'); });
        const receipt = await enqueueOwnPublications([result], { clipIdsByReviewIndex: { 1: 17 } }, process.cwd(), invoke);
        expect(receipt).toMatchObject({ outcomeUnknown: true, queuedIds: [], error: 'receipt lost' });
        expect(invoke).toHaveBeenCalledTimes(1);
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('topic runtime binds fresh preflight evidence and stable manifest IDs using the same Python authorization contract', async () => {
    const f = fixture();
    try {
        f.context.config = { mode: 'auto', policyVersion: 'topic-v1', scope: 'configured_keywords', enabled: true,
            keywords: ['岁己'], ignoredRoomIds: [], activatedAt: '2026-10-03T00:00:00Z', authorizationNote: 'Authorized by fixture' };
        f.context.streamerName = '另一位主播';
        const item = f.artifact(1), hash = 'a'.repeat(64);
        Object.assign(item, { mode: 'local_review', status: 'success', publicationKind: 'keyword_topic', reviewIndex: 7,
            source: { ...item.source, sourceKind: 'video' },
            aiReview: { version: 1, mode: 'preflight', status: 'ready', applied: true, sourceSha256: hash,
                window: { start: 0, end: 20 }, quality: { status: 'pass', issues: [] },
                keyword: { status: 'confirmed', hits: [{ id: 'K1', cueId: 'G1', start: 1, end: 15, text: '完整原话',
                    keywords: ['岁己'], verdict: 'mention', reason: '片内指代明确', evidenceCueIds: ['G1'] }] },
                subtitleEdits: [], warnings: [], rejectedSubtitleEdits: [], boundaryReview: null },
            editorial: { status: 'planned', copyStatus: 'prepared', sourceKind: 'recount', copyWindow: { start: 0, end: 20 },
                copyGrounding: { version: 1, status: 'linked', sourceSha256: hash, sourceKind: 'recount', issues: [],
                    subtitleIds: ['G1'], danmakuIds: [] } } });
        f.adapters.evidence = jest.fn(f.adapters.evidence);
        const [result] = await reviewPublications([item], f.context, f.adapters);
        expect(result.publicationDecision).toMatchObject({ policyVersion: 'topic-v1', action: 'auto_queue' });
        expect(f.adapters.evidence).toHaveBeenCalledWith([{ start: 1, end: 15, text: '完整原话' }]);
        const evidence = JSON.parse((f.adapters.request as jest.Mock).mock.calls[0][1].split('EVIDENCE_JSON ')[1]);
        expect(evidence.topicEvidence).toEqual(result.publicationReview.topicEvidence);
        expect(evidence.evidence.cues).toEqual([{ id: 'G1', start: 1, end: 15, text: '完整原话' }]);
        const invoke = jest.fn(async () => 'AUTOMATIC_ENQUEUE_RESULT: {"queuedIds":[73],"results":[{"id":73,"status":"queued"}]}');
        await enqueuePublications([result], { clipIdsByReviewIndex: { 1: 999, 7: 73 } }, process.cwd(), invoke);
        expect(invoke).toHaveBeenCalledWith([73]);
        const config = { clipTopics: { enabled: true, keywords: ['岁己'], ignoredRoomIds: [], automaticPublication: f.context.config } };
        const validate = () => spawnSync('python', ['-c',
            'import json,sys;from pathlib import Path;from src.scripts.clip_auto_publication import validate_publication_review,validate_policy;metadata=json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"));validate_publication_review(metadata);validate_policy(metadata,json.loads(sys.argv[2]))',
            result.output.metadataPath, JSON.stringify(config)], { cwd: process.cwd(), encoding: 'utf8', windowsHide: true, shell: false });
        const accepted = validate();
        expect(accepted.stderr).toBe(''); expect(accepted.status).toBe(0);
        result.aiReview.keyword.hits[0].reason = '改变原预审理由';
        fs.writeFileSync(result.output.metadataPath, JSON.stringify(result));
        const changed = validate();
        expect(changed.status).not.toBe(0); expect(changed.stderr).toContain('topic');
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('topic runtime rejects stale preflight source evidence without querying the final model', async () => {
    const f = fixture();
    try {
        f.context.config = { ...f.context.config, policyVersion: 'topic-v1', scope: 'configured_keywords', enabled: true,
            keywords: ['岁己'], ignoredRoomIds: [] };
        const item = f.artifact(1);
        Object.assign(item, { mode: 'local_review', status: 'success', publicationKind: 'keyword_topic',
            source: { ...item.source, sourceKind: 'video' },
            aiReview: { sourceSha256: 'b'.repeat(64) } });
        const [result] = await reviewPublications([item], f.context, f.adapters);
        expect(result.publicationReview.issues).toContain('topic_preflight_source_stale');
        expect(f.adapters.request).not.toHaveBeenCalled();
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});
