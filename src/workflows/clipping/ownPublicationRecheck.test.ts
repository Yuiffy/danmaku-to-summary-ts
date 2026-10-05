import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { recheckOwnPublication } from './ownPublicationRecheck';
import type { Artifact } from './enhancement';

function fixture() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'own-publication-recheck-'));
    const source = { mediaPath: path.join(directory, 'source.flv'), srtPath: path.join(directory, 'source.srt') };
    const file = path.join(directory, 'clip.json'), registry = path.join(directory, 'registry.json'), queue = path.join(directory, 'queue.json');
    const artifact: Artifact = { mode: 'own_stream_fun_review', roomId: '25788785', generatedAt: '2026-10-04T00:00:00Z', source,
        copy: { title: '几个月', description: '几个月', coverText: '几个月' }, window: { start: 0, end: 20, duration: 20 }, uploadReady: true,
        output: { metadataPath: file, mediaPath: path.join(directory, 'clip.mp4'), srtPath: path.join(directory, 'clip.srt'),
            coverPath: path.join(directory, 'cover.jpg'), burnedSubtitles: true },
        publicationReview: { status: 'needs_review', checks: { content: false, attribution: true, subtitles: true, visuals: true, policy: true },
            technical: { passed: true }, issues: ['标题月份不准确'] } };
    for (const name of [source.mediaPath, source.srtPath, artifact.output.mediaPath, artifact.output.srtPath, artifact.output.coverPath!]) fs.writeFileSync(name, name);
    fs.writeFileSync(file, JSON.stringify(artifact));
    const record = { id: 7, status: 'needs_review', metadataPath: file, attributionRequired: true, qaRequired: false };
    const store = { clips: { 7: record } };
    fs.writeFileSync(registry, JSON.stringify(store)); fs.writeFileSync(queue, JSON.stringify({ jobs: [] }));
    const args = ['--id', '7', '--metadata', file, '--registry-path', registry, '--queue-path', queue];
    const io = { config: () => ({ automaticPublication: { mode: 'auto', roomIds: ['25788785'], activatedAt: '2026-10-03T00:00:00Z', authorizationNote: '自动授权' } }),
        lock: (name: string) => { const lockPath = `${name}.cut.lock`; return { lock: fs.openSync(lockPath, 'wx'), lockPath }; },
        repair: jest.fn(async (row: Artifact, required: any) => ({ ...row, ...required, copy: { ...row.copy, title: '可能一个月' },
            automaticCopyRepair: { authority: 'automatic' }, publicationReview: { status: 'passed' }, publicationDecision: { action: 'auto_queue' } })) };
    return { directory, file, queue, registry, artifact, record, store, args, io };
}

test('explicit copy recheck saves a backup and keeps numeric identity, source media and subtitle bytes', async () => {
    const f = fixture();
    try {
        const before = fs.readFileSync(f.file, 'utf8'), video = fs.readFileSync(f.artifact.output.mediaPath);
        const result = await recheckOwnPublication(f.args, f.io);
        expect(result).toMatchObject({ id: 7, changed: true, status: 'passed', decision: 'auto_queue' });
        expect(f.io.repair).toHaveBeenCalledWith(f.artifact, { attributionRequired: true, qaRequired: false }, false);
        expect(fs.readFileSync(path.join(result.backupDirectory, 'BEFORE.json'), 'utf8')).toBe(before);
        expect(fs.readFileSync(f.artifact.output.mediaPath)).toEqual(video);
        expect(JSON.parse(fs.readFileSync(f.file, 'utf8')).attributionRequired).toBe(true);
        expect(JSON.parse(fs.readFileSync(f.registry, 'utf8')).clips[7].status).toBe('needs_review');
        expect(fs.existsSync(f.file + '.cut.lock')).toBe(false);
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('active queue ownership and source changes during review prevent committing a revision', async () => {
    for (const kind of ['active', 'source', 'claimed']) {
        const f = fixture();
        try {
            const before = fs.readFileSync(f.file, 'utf8');
            if (kind === 'active') fs.writeFileSync(f.queue, JSON.stringify({ jobs: [{ status: 'pending', clipIds: [7] }] }));
            else {
                const repair = f.io.repair;
                f.io.repair = jest.fn(async (row, required) => {
                    if (kind === 'source') fs.writeFileSync(row.source.srtPath, 'changed');
                    else fs.writeFileSync(f.queue, JSON.stringify({ jobs: [{ status: 'running', clipIds: [7] }] }));
                    return repair(row, required);
                });
            }
            await expect(recheckOwnPublication(f.args, f.io)).rejects.toThrow(/changed|inactive/u);
            expect(fs.readFileSync(f.file, 'utf8')).toBe(before);
            if (kind === 'active') expect(f.io.repair).not.toHaveBeenCalled();
        } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
    }
});

test('a terminal old queue authorization does not prevent final review and remains unchanged until explicit enqueue', async () => {
    const f = fixture();
    try {
        const authorization = { authority: 'configured_policy', publicationIdentity: 'previous-window' };
        fs.writeFileSync(f.registry, JSON.stringify({ clips: { 7: { ...f.record, automaticPublicationAuthorization: authorization } } }));
        fs.writeFileSync(f.queue, JSON.stringify({ jobs: [{ status: 'failed', clipIds: [7] }] }));
        const registryBefore = fs.readFileSync(f.registry, 'utf8'), queueBefore = fs.readFileSync(f.queue, 'utf8');
        const reviewFinal = jest.fn(async (row: Artifact, required: any) => ({ ...row, ...required,
            publicationReview: { status: 'passed' }, publicationDecision: { action: 'auto_queue' } }));
        await expect(recheckOwnPublication([...f.args, '--review-final'], { ...f.io, reviewFinal }))
            .resolves.toMatchObject({ id: 7, changed: true, status: 'passed' });
        expect(fs.readFileSync(f.registry, 'utf8')).toBe(registryBefore);
        expect(fs.readFileSync(f.queue, 'utf8')).toBe(queueBefore);
        expect(reviewFinal).toHaveBeenCalledTimes(1);
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('explicit subtitle recheck forwards the opt-in while ID and authority changes cannot be committed', async () => {
    for (const mutation of [null, 'id', 'authority']) {
        const f = fixture();
        try {
            f.artifact.publicationReview.checks.content = true;
            f.artifact.publicationReview.checks.subtitles = false;
            f.artifact.publicationReview.issues = ['字幕“预气”待核对'];
            fs.writeFileSync(f.file, JSON.stringify(f.artifact));
            const before = fs.readFileSync(f.file, 'utf8'), original = f.io.repair;
            f.io.repair = jest.fn(async (row, required) => ({ ...await original(row, required),
                ...(mutation === 'id' ? { uploadId: 8 } : {}), ...(mutation === 'authority' ? { ownStreamHumanReview: {} } : {}) }));
            const work = recheckOwnPublication([...f.args, '--repair-subtitles'], f.io);
            if (mutation) { await expect(work).rejects.toThrow('identity'); expect(fs.readFileSync(f.file, 'utf8')).toBe(before); }
            else { await expect(work).resolves.toMatchObject({ id: 7, changed: true });
                expect(f.io.repair).toHaveBeenCalledWith(f.artifact, { attributionRequired: true, qaRequired: false }, true); }
        } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
    }
});

test('explicit final recheck reevaluates existing subtitle blockers with no repair and preserves every artifact digest', async () => {
    const f = fixture();
    try {
        f.artifact.publicationReview.checks.content = true;
        f.artifact.publicationReview.checks.subtitles = false;
        f.artifact.publicationReview.issues = ['“预气”疑为错字'];
        fs.writeFileSync(f.file, JSON.stringify(f.artifact));
        const before = fs.readFileSync(f.file, 'utf8');
        const files = [f.artifact.source.mediaPath, f.artifact.source.srtPath, f.artifact.output.mediaPath,
            f.artifact.output.srtPath, f.artifact.output.coverPath!];
        const bytes = files.map(file => fs.readFileSync(file));
        const reviewFinal = jest.fn(async (row: Artifact, required: any) => ({ ...row, ...required,
            publicationReview: { status: 'passed' }, publicationDecision: { action: 'auto_queue' } }));
        const result = await recheckOwnPublication([...f.args, '--review-final'], { ...f.io, reviewFinal });
        expect(result).toMatchObject({ id: 7, changed: true, decision: 'auto_queue' });
        expect(reviewFinal).toHaveBeenCalledWith(f.artifact, { attributionRequired: true, qaRequired: false });
        expect(f.io.repair).not.toHaveBeenCalled();
        expect(files.map(file => fs.readFileSync(file))).toEqual(bytes);
        expect(fs.readFileSync(path.join(result.backupDirectory, 'BEFORE.json'), 'utf8')).toBe(before);
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test.each(['copy', 'requirement', 'claimed', 'human', 'published', 'disabled', 'historical'])('final recheck cannot commit a %s change or bypass automatic scope', async kind => {
    const f = fixture();
    try {
        const before = fs.readFileSync(f.file, 'utf8');
        const reviewFinal = jest.fn(async (row: Artifact) => {
            if (kind === 'claimed') fs.writeFileSync(f.queue, JSON.stringify({ jobs: [{ status: 'pending', clipIds: [7] }] }));
            return { ...row, attributionRequired: kind !== 'requirement',
                ...(kind === 'copy' ? { copy: { ...row.copy, title: '不同标题' } } : {}),
                ...(kind === 'human' ? { ownStreamHumanReview: { status: 'approved' } } : {}),
                publicationReview: { status: 'passed' }, publicationDecision: { action: 'auto_queue' } };
        });
        const config = () => ({ automaticPublication: { ...f.io.config().automaticPublication,
            ...(kind === 'disabled' ? { mode: 'off' } : {}),
            ...(kind === 'historical' ? { activatedAt: '2026-10-05T00:00:00Z' } : {}) } });
        if (kind === 'published') fs.writeFileSync(f.registry, JSON.stringify({ clips: { 7: { ...f.record, status: 'uploaded', bvid: 'existing' } } }));
        const work = recheckOwnPublication([...f.args, '--review-final'], { ...f.io, config, reviewFinal });
        if (['disabled', 'historical'].includes(kind)) {
            await expect(work).resolves.toMatchObject({ changed: false });
            expect(reviewFinal).not.toHaveBeenCalled();
        } else await expect(work).rejects.toThrow(/changed|required|inactive|identity/u);
        expect(fs.readFileSync(f.file, 'utf8')).toBe(before);
        expect(f.io.repair).not.toHaveBeenCalled();
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});
