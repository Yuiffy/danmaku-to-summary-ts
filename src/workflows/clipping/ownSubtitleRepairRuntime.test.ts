import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { repairOwnSubtitles, renderRepairedSubtitles, RepairIO } from './ownSubtitleRepairRuntime';
import { publicationSnapshot } from './publicationRuntime';
import type { Artifact } from './enhancement';

const digest = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const policy = { mode: 'auto' as const, roomIds: ['25788785'], authorizationNote: '自动授权', activatedAt: '2026-10-03T00:00:00Z' };

async function fixture() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-subtitle-repair-'));
    const cues = [{ start: 6, end: 8, text: '线下问路我就没有这种被凶的预气所以很无所谓很自信' }, { start: 14, end: 16, text: '其他一句保留' }];
    const source = { mediaPath: path.join(directory, 'source.flv'), srtPath: path.join(directory, 'source.srt') };
    const artifact: Artifact = { mode: 'own_stream_fun_review', roomId: '25788785', source, generatedAt: '2026-10-04T00:00:00Z',
        window: { start: 100, end: 120, duration: 20 }, copy: { title: '问路', coverText: '很自信', description: '线下问路' }, uploadReady: true,
        output: { mediaPath: path.join(directory, 'clip.mp4'), srtPath: path.join(directory, 'clip.srt'),
            metadataPath: path.join(directory, 'clip.json'), coverPath: path.join(directory, 'cover.jpg'), burnedSubtitles: true },
        publicationReview: { status: 'needs_review', technical: { passed: true },
            checks: { content: true, attribution: true, subtitles: false, visuals: true, policy: true }, issues: ['字幕“预气”需核对原音'] } };
    for (const file of [source.mediaPath, source.srtPath, artifact.output.mediaPath, artifact.output.coverPath!]) fs.writeFileSync(file, file);
    fs.writeFileSync(artifact.output.srtPath, JSON.stringify(cues));
    const snapshot = await publicationSnapshot(artifact);
    artifact.publicationReview = { ...artifact.publicationReview, ...snapshot };
    const io: RepairIO = { parse: read, write: (file, rows) => fs.writeFileSync(file, JSON.stringify(rows)),
        python: { executable: 'unused', args: [] }, scriptPath: __filename, protectedNames: ['小岁'], settings: { model: 'nano', sensevoiceModel: 'sensevoice' },
        runAudio: jest.fn(async (input, output) => {
            const request = read(input), wav = path.join(path.dirname(output), 'A1.wav');
            fs.writeFileSync(wav, 'original source audio');
            const windows = request.windows.map((row: any) => ({ ...row, audioPath: wav, audioSha256: digest(wav),
                decodes: ['nano', 'sensevoice'].map(model => ({ model, text: cues[0].text.replace('预气', '预期'),
                    prompted: false, hotwords: [], useItn: false })) }));
            fs.writeFileSync(output, JSON.stringify({ version: 1, source: request.source, requestSha256: request.requestSha256, windows }));
        }),
        render: jest.fn(async (row, srt, target) => { const video = path.join(target, 'new.mp4'); fs.writeFileSync(video, 'new burned video');
            return { ...row, output: { ...row.output, mediaPath: video, srtPath: srt } }; }),
        reviewCopy: jest.fn(async row => ({ ...row, attributionRequired: true, attributionReview: { status: 'passed' } })),
        reviewFinal: jest.fn(async row => ({ ...row, publicationReview: { ...await publicationSnapshot(row), status: 'passed' },
            publicationDecision: { action: 'auto_queue' } })) };
    return { directory, artifact, io, cues };
}

test('a literal source-audio consensus rebuilds separately and independently reviews under the same metadata ID', async () => {
    const f = await fixture();
    try {
        const before = fs.readFileSync(f.artifact.output.srtPath, 'utf8'), source = fs.readFileSync(f.artifact.source.srtPath);
        const result = await repairOwnSubtitles(f.artifact, policy, { attributionRequired: true }, f.io);
        expect(read(result.output.srtPath)).toEqual([{ ...f.cues[0], text: f.cues[0].text.replace('预气', '预期') }, f.cues[1]]);
        expect(fs.readFileSync(f.artifact.output.srtPath, 'utf8')).toBe(before);
        expect(fs.readFileSync(f.artifact.source.srtPath)).toEqual(source);
        expect(result.output.metadataPath).toBe(f.artifact.output.metadataPath);
        expect(result.publicationDecision.action).toBe('auto_queue');
        expect(result.ownStreamHumanReview).toBeUndefined();
        expect(f.io.reviewCopy).toHaveBeenCalledTimes(1); expect(f.io.reviewFinal).toHaveBeenCalledTimes(1);
        expect(result.publicationReview.digests.subtitleAudio).toBe(result.automaticSubtitleRepair.proofSha256);
        const metadata = path.join(f.directory, 'result.json'); fs.writeFileSync(metadata, JSON.stringify(result));
        const checked = spawnSync('python', ['-c', 'import json,sys;from pathlib import Path;from src.scripts.ordinary_subtitle_evidence import validate_subtitle_audio_evidence; m=json.loads(Path(sys.argv[1]).read_text(encoding="utf-8")); assert validate_subtitle_audio_evidence(m,m["publicationReview"]["source"]) == m["publicationReview"]["digests"]["subtitleAudio"]', metadata],
            { cwd: process.cwd(), encoding: 'utf8', windowsHide: true, shell: false });
        expect(checked.stderr).toBe(''); expect(checked.status).toBe(0);
        result.automaticSubtitleRepair.edits[0].to = '语气';
        await expect(publicationSnapshot(result)).rejects.toThrow('proof changed');
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('inconclusive editing returns bound diagnosis to final review without rewriting words or blindly repeating ASR', async () => {
    const f = await fixture();
    try {
        const run = f.io.runAudio!;
        f.io.runAudio = jest.fn(async (input, output) => { await run(input, output); const audio = read(output);
            audio.windows[0].decodes[1].text = f.cues[0].text; fs.writeFileSync(output, JSON.stringify(audio)); });
        f.io.reviewFinal = jest.fn(async row => ({ ...row, publicationReview: { ...row.publicationReview,
            ...await publicationSnapshot(row), status: 'needs_review' }, publicationDecision: { action: 'needs_human' } }));
        const result = await repairOwnSubtitles(f.artifact, policy, {}, f.io);
        expect(result.automaticSubtitleRepairAttempt.status).toBe('inconclusive');
        expect(result.output).toBe(f.artifact.output);
        expect(f.io.render).not.toHaveBeenCalled(); expect(f.io.reviewFinal).toHaveBeenCalledTimes(1);
        expect(result.publicationDecision.action).toBe('needs_human');
        expect(result.publicationReview.digests.subtitleDiagnostic).toMatch(/^[a-f0-9]{64}$/u);
        const metadata = path.join(f.directory, 'diagnostic.json'); fs.writeFileSync(metadata, JSON.stringify(result));
        const checked = spawnSync('python', ['-c', 'import json,sys;from pathlib import Path;from src.scripts.ordinary_subtitle_evidence import validate_subtitle_diagnostic; m=json.loads(Path(sys.argv[1]).read_text(encoding="utf-8")); assert validate_subtitle_diagnostic(m,m["publicationReview"]["source"]) == m["publicationReview"]["digests"]["subtitleDiagnostic"]', metadata],
            { cwd: process.cwd(), encoding: 'utf8', windowsHide: true, shell: false });
        expect(checked.stderr).toBe(''); expect(checked.status).toBe(0);
        expect(await repairOwnSubtitles(result, policy, {}, f.io)).toBe(result);
        expect(f.io.runAudio).toHaveBeenCalledTimes(1);
        const audio = read(result.automaticSubtitleRepairAttempt.evidencePath);
        fs.writeFileSync(audio.windows[0].audioPath, 'tampered');
        await expect(publicationSnapshot(result)).rejects.toThrow('diagnostic audio changed');
        const rejected = spawnSync('python', ['-c', 'import json,sys;from pathlib import Path;from src.scripts.ordinary_subtitle_evidence import validate_subtitle_diagnostic; m=json.loads(Path(sys.argv[1]).read_text(encoding="utf-8")); validate_subtitle_diagnostic(m,m["publicationReview"]["source"])', metadata],
            { cwd: process.cwd(), encoding: 'utf8', windowsHide: true, shell: false });
        expect(rejected.status).not.toBe(0);
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('source mutation, audio hash tampering and legacy required QA stop a repair before rendering', async () => {
    for (const kind of ['source', 'audio', 'qa']) {
        const f = await fixture();
        try {
            const run = f.io.runAudio!;
            f.io.runAudio = jest.fn(async (input, output) => { await run(input, output);
                if (kind === 'source') fs.writeFileSync(f.artifact.source.srtPath, 'changed source');
                if (kind === 'audio') fs.writeFileSync(read(output).windows[0].audioPath, 'changed audio'); });
            if (kind === 'qa') expect(await repairOwnSubtitles(f.artifact, policy, { qaRequired: true }, f.io)).toBe(f.artifact);
            else await expect(repairOwnSubtitles(f.artifact, policy, {}, f.io)).rejects.toThrow(/changed/u);
            expect(f.io.render).not.toHaveBeenCalled(); expect(f.io.reviewFinal).not.toHaveBeenCalled();
        } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
    }
});

test('a source-only rebuild can return audio diagnosis but cannot replace its rendered subtitle receipt', async () => {
    const f=await fixture();
    try {
        f.artifact.renderedSubtitles={revision:0,edits:[],path:f.artifact.output.srtPath,sha256:digest(f.artifact.output.srtPath)};
        const result=await repairOwnSubtitles(f.artifact,policy,{},f.io);
        expect(result.automaticSubtitleRepairAttempt.status).toBe('inconclusive');
        expect(result.renderedSubtitles).toBe(f.artifact.renderedSubtitles);
        expect(result.output).toBe(f.artifact.output);
        expect(f.io.render).not.toHaveBeenCalled();expect(f.io.reviewCopy).not.toHaveBeenCalled();
        expect(result.publicationReview.digests.subtitleDiagnostic).toMatch(/^[a-f0-9]{64}$/u);
    } finally {fs.rmSync(f.directory,{recursive:true,force:true});}
});

test('an alignment update reuses hash-bound prior audio without invoking either ASR model again', async () => {
    const f = await fixture();
    try {
        const originalRun = f.io.runAudio!;
        f.io.runAudio = jest.fn(async (input, output) => { await originalRun(input, output); const audio = read(output);
            audio.windows[0].decodes[1].text = f.cues[0].text; fs.writeFileSync(output, JSON.stringify(audio)); });
        f.io.reviewFinal = jest.fn(async row => ({ ...row, publicationReview: { ...row.publicationReview,
            ...await publicationSnapshot(row), status: 'needs_review' } }));
        const attempt = await repairOwnSubtitles(f.artifact, policy, {}, f.io);
        delete attempt.automaticSubtitleRepairAttempt.alignmentVersion;
        const resumed = await repairOwnSubtitles(attempt, policy, {}, f.io);
        expect(resumed.automaticSubtitleRepairAttempt.alignmentVersion).toBe('cue-consensus-v4');
        expect(f.io.runAudio).toHaveBeenCalledTimes(1);
        expect(f.io.render).not.toHaveBeenCalled();
        const originalAudio = read(attempt.automaticSubtitleRepairAttempt.evidencePath), reused = read(resumed.automaticSubtitleRepairAttempt.evidencePath);
        expect(reused.windows[0].decodes).toEqual(originalAudio.windows[0].decodes);
        expect(reused.windows[0].audioSha256).toBe(originalAudio.windows[0].audioSha256);
        expect(reused.windows[0].audioPath).not.toBe(originalAudio.windows[0].audioPath);
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('a newly quoted blocker gets at most one narrower follow-up and keeps the previous proof at the upload boundary', async () => {
    const f = await fixture();
    try {
        f.cues[1].text = '其他一句保留痕己然后继续这个话题';
        fs.writeFileSync(f.artifact.output.srtPath, JSON.stringify(f.cues));
        Object.assign(f.artifact.publicationReview, await publicationSnapshot(f.artifact));
        const first = await repairOwnSubtitles(f.artifact, policy, {}, f.io);
        first.publicationReview = { ...first.publicationReview, status: 'needs_review', technical: { passed: true },
            checks: { content: true, attribution: true, subtitles: false, visuals: true, policy: true }, issues: ['字幕“痕己”需要核对'] };
        const run = f.io.runAudio!;
        f.io.runAudio = jest.fn(async (input, output) => { await run(input, output); const audio = read(output);
            audio.windows[0].decodes.forEach((row: any) => { row.text = f.cues[1].text.replace('痕己', '痕迹'); });
            fs.writeFileSync(output, JSON.stringify(audio)); });
        const second = await repairOwnSubtitles(first, policy, {}, f.io);
        expect(read(second.output.srtPath)[0].text).toContain('预期');
        expect(read(second.output.srtPath)[1].text).toContain('痕迹');
        expect(second.automaticSubtitleRepair.generation).toBe(2);
        expect(second.automaticSubtitleRepair.allEdits.map((row: any) => row.from)).toEqual(['预气', '痕己']);
        const request = read(second.automaticSubtitleRepair.requestPath);
        expect(request.windows).toEqual([{ id: 'A1', start: 113.75, end: 116.25 }]);
        const metadata = path.join(f.directory, 'followup.json'); fs.writeFileSync(metadata, JSON.stringify(second));
        const checked = spawnSync('python', ['-c', 'import json,sys;from pathlib import Path;from src.scripts.ordinary_subtitle_evidence import validate_subtitle_audio_evidence;m=json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"));validate_subtitle_audio_evidence(m,m["publicationReview"]["source"])', metadata],
            { cwd: process.cwd(), encoding: 'utf8', windowsHide: true, shell: false });
        expect(checked.stderr).toBe(''); expect(checked.status).toBe(0);
        second.publicationReview = { ...second.publicationReview, status: 'needs_review', technical: { passed: true },
            checks: first.publicationReview.checks, issues: ['字幕“其他一句”需核对'] };
        expect(await repairOwnSubtitles(second, policy, {}, f.io)).toBe(second);
        expect(f.io.runAudio).toHaveBeenCalledTimes(1);
        fs.writeFileSync(first.automaticSubtitleRepair.correctedSrtPath, 'changed first correction');
        await expect(publicationSnapshot(second)).rejects.toThrow('proof changed');
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('a newly localized issue merges overlapping probes and counts prior diagnostics against the audio budget', async () => {
    const f = await fixture();
    try {
        const originalRun = f.io.runAudio!;
        f.io.runAudio = jest.fn(async (input, output) => { await originalRun(input, output); const audio = read(output);
            audio.windows[0].decodes[1].text = f.cues[0].text; fs.writeFileSync(output, JSON.stringify(audio)); });
        f.io.reviewFinal = jest.fn(async row => ({ ...row, publicationReview: { ...row.publicationReview,
            ...await publicationSnapshot(row), status: 'needs_review' } }));
        const first = await repairOwnSubtitles(f.artifact, policy, {}, f.io);
        first.automaticSubtitleRepairAttempt.alignmentVersion = 'older';
        first.publicationReview.issues.push('字幕“其他一句”也需要核对');
        const second = await repairOwnSubtitles(first, policy, {}, f.io);
        const request = read(path.join(path.dirname(second.automaticSubtitleRepairAttempt.evidencePath), 'request.json'));
        expect(request.windows).toEqual([{ id: 'A1', start: 101, end: 120 }]);
        expect(request.priorWindows).toEqual([{ id: 'A1', start: 101, end: 113 }]);
        expect(f.io.runAudio).toHaveBeenCalledTimes(2);
        second.automaticSubtitleRepairAttempt.alignmentVersion = 'older';
        await repairOwnSubtitles(second, policy, {}, f.io);
        expect(f.io.runAudio).toHaveBeenCalledTimes(2); // The same merged request reuses its evidence.
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('standard rendering receives source window, corrected SRT, copy mode and adaptive threads; an unburned result fails', async () => {
    const f = await fixture();
    try {
        const cutMedia = jest.fn(async (_source, _window, _srt, output, config) => {
            fs.writeFileSync(output, 'burned'); return { path: output, burnedSubtitles: true, twoStageMode: config.twoStageMode }; });
        const adapters = { mediaConfig: { subtitleVideoEncoder: 'h264_nvenc', subtitleHwaccel: 'cuda' }, cutMedia,
            withMedia: async (work: any) => work({ mode: 'interactive', ffmpegThreads: 1 }) };
        const target = path.join(f.directory, 'render'); fs.mkdirSync(target);
        const result = await renderRepairedSubtitles(f.artifact, f.artifact.output.srtPath, target, adapters);
        expect(cutMedia).toHaveBeenCalledWith({ mediaPath: f.artifact.source.mediaPath, kind: 'video', uploadReady: true },
            f.artifact.window, f.artifact.output.srtPath, path.join(target, 'clip.mp4'), expect.objectContaining({
                twoStageMode: 'copy', twoStageSubtitleBurn: true, burnSubtitles: true, ffmpegThreads: 1, subtitleVideoEncoder: 'h264_nvenc' }));
        expect(result.output.metadataPath).toBe(f.artifact.output.metadataPath);
        expect(result.ownStreamHumanReview).toBeUndefined();
        cutMedia.mockResolvedValue({ path: path.join(target, 'clip.mp4'), burnedSubtitles: false, twoStageMode: 'copy' });
        await expect(renderRepairedSubtitles(f.artifact, f.artifact.output.srtPath, target, adapters)).rejects.toThrow('burned media');
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});
