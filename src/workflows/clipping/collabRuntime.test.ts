import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildCollabDossier, CollabIO, readJson, renderCollab, shotArguments, jsonHash, filterFile } from './collabRuntime';
import { compileCollab } from './collabPolicy';
let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-')); });
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
function fixture() {
    for (const id of ['sui', 'peer']) {
        fs.writeFileSync(path.join(directory, `${id}.mp4`), id);
        fs.writeFileSync(path.join(directory, `${id}.srt`), '1\n00:00:02,000 --> 00:00:03,000\n测试原声\n');
        fs.writeFileSync(path.join(directory, `${id}.xml`), '<i><d p="2,1,25,16777215">真实弹幕 &amp; 原文</d></i>');
    }
    const sessionPath = path.join(directory, 'session.json'), dossierPath = path.join(directory, 'dossier.json');
    const sources = ['sui', 'peer'].map((id, i) => ({ id, name: i ? '队友' : '岁己', roomId: String(i + 1), mediaPath: `${id}.mp4`,
        srtPath: `${id}.srt`, xmlPath: `${id}.xml`, protectedRegions: [],
        sync: i ? [{ primary: { start: 0, end: 20 }, local: { start: 1, end: 21 }, basis: 'shared_game', reviewNote: '实际动作帧校验' }] : [] }));
    fs.writeFileSync(sessionPath, JSON.stringify({ version: 1, primaryId: 'sui', sources }));
    const output = path.join(directory, 'render'), planPath = path.join(directory, 'plan.json'), font = path.join(directory, 'font.ttf');
    fs.writeFileSync(font, 'font');
    const io: CollabIO = { probe: jest.fn(async file => ({ duration: file.endsWith('collab.mp4') ? 4 : 30, width: 640, height: 360, audio: true })),
        run: jest.fn(async args => { const out = args.at(-1)!; if (out !== '-') fs.writeFileSync(out, 'rendered'); }),
        subtitleAss: jest.fn(() => 'production ASS'), auditAudio: jest.fn(async () => ({ status: 'passed' })) };
    return { sessionPath, dossierPath, output, planPath, font, io };
}
async function ready() {
    const f = fixture(), dossier = await buildCollabDossier(f.sessionPath, f.dossierPath, f.io);
    const plan = { version: 1 as const, dossierSha256: dossier.sha256, shots: [{ mode: 'primary' as const, sourceId: 'sui',
        start: 1, end: 5, reason: '完整铺垫与反应', evidenceIds: ['sui:S1'], overlays: [{ sourceId: 'peer', kind: 'face' as const,
            start: 2, end: 4, crop: [.5, .1, .4, .6] as [number, number, number, number], placement: [.6, .2, .35, .5] as [number, number, number, number], reviewNote: '实际画面位置' }] }] };
    fs.writeFileSync(f.planPath, JSON.stringify(plan));
    return { ...f, dossier, plan };
}
test('dossier retains room identities, decoded XML, original cue IDs and unmapped coverage', async () => {
    const f = fixture(), session = readJson(f.sessionPath); session.sources[1].sync = [];
    fs.writeFileSync(f.sessionPath, JSON.stringify(session));
    const d = await buildCollabDossier(f.sessionPath, f.dossierPath, f.io);
    expect(d.rows.find(r => r.id === 'peer:D1')).toMatchObject({ text: '真实弹幕 & 原文', primaryStart: null });
    expect(d.coverage).toMatchObject({ includedRows: 4, unmappedRows: 2 });
    expect(d.files).toHaveLength(7);
});
test('filters bind different video clocks, never mix peer audio or repeat a frozen final frame', async () => {
    const f = await ready(), timeline = compileCollab(f.dossier.session, f.plan, f.dossier.media, f.dossier.subtitles, f.dossier.rows);
    const args = shotArguments(timeline.shots[0], f.dossier, f.output, ['label.txt'], 'font.ttf');
    const filter = args[args.indexOf('-filter_complex') + 1];
    expect(filter).toContain('repeatlast=0'); expect(filter).toContain('expansion=none');
    expect(filter).toContain('[0:a:0]'); expect(filter).not.toContain('[1:a'); expect(filter).not.toContain('amix');
    expect(args).toContain('3'); // peer local start = primary 2 + offset 1
});
test('filter filenames escape both libavfilter parsing layers, without shell quoting', () => {
    const escaped = filterFile("D:/a's space/字,[x];b.ass");
    expect(escaped).toContain('D\\\\:');
    expect(escaped).toContain("a\\\\\\'s");
    expect(escaped).toContain('字\\,\\[x\\]\\;b.ass');
    expect(() => filterFile('bad\nname')).toThrow(/newline/);
});
test('render exports a new pending revision, mapped SRT and three pairs of source/composite frames', async () => {
    const f = await ready(), result = await renderCollab(f.dossierPath, f.planPath, f.output, f.font, f.io);
    expect(result).toMatchObject({ status: 'pending_review', uploadReady: false, checks: { fullDecode: 'passed', visualReview: 'pending' } });
    expect(result.previews).toHaveLength(3);
    expect(fs.readFileSync(result.output.srtPath, 'utf8')).toContain('00:00:01,000 --> 00:00:02,000');
    await expect(renderCollab(f.dossierPath, f.planPath, f.output, f.font, f.io)).rejects.toThrow(/exists/);
});
test.each(['source', 'dossier', 'plan'])('changed %s binding blocks rendering before IO', async kind => {
    const f = await ready(); (f.io.run as jest.Mock).mockClear();
    if (kind === 'source') fs.writeFileSync(path.join(directory, 'peer.mp4'), 'changed');
    if (kind === 'dossier') { f.dossier.rows[0].text = 'changed'; fs.writeFileSync(f.dossierPath, JSON.stringify(f.dossier)); }
    if (kind === 'plan') fs.writeFileSync(f.planPath, JSON.stringify({ ...f.plan, dossierSha256: 'other' }));
    await expect(renderCollab(f.dossierPath, f.planPath, f.output, f.font, f.io)).rejects.toThrow(/binding|changed/);
    expect(f.io.run).not.toHaveBeenCalled();
});
test('decode failure writes failure evidence without a successful result', async () => {
    const f = await ready(), original = f.io.run;
    f.io.run = async args => { if (args.includes('-xerror')) throw new Error('decode failed'); return original(args); };
    await expect(renderCollab(f.dossierPath, f.planPath, f.output, f.font, f.io)).rejects.toThrow(/decode/);
    expect(fs.existsSync(path.join(f.output, 'RESULT.json'))).toBe(false);
    expect(readJson(path.join(f.output, 'FAILED.json')).uploadReady).toBe(false);
});
test('audio audit failure cannot produce a successful pending revision', async () => {
    const f = await ready(); f.io.auditAudio = async () => { throw new Error('Wrong audio source'); };
    await expect(renderCollab(f.dossierPath, f.planPath, f.output, f.font, f.io)).rejects.toThrow(/audio source/);
    expect(fs.existsSync(path.join(f.output, 'RESULT.json'))).toBe(false);
});
test('a returned failed audio audit also blocks success metadata', async () => {
    const f = await ready(); f.io.auditAudio = async () => ({ status: 'failed' });
    await expect(renderCollab(f.dossierPath, f.planPath, f.output, f.font, f.io)).rejects.toThrow(/preservation/);
    expect(fs.existsSync(path.join(f.output, 'RESULT.json'))).toBe(false);
});
test('media modified while creating a dossier is rejected', async () => {
    const f = fixture(), probe = f.io.probe;
    f.io.probe = async file => { fs.appendFileSync(file, 'growing'); return probe(file); };
    await expect(buildCollabDossier(f.sessionPath, f.dossierPath, f.io)).rejects.toThrow(/changed/);
    expect(fs.existsSync(f.dossierPath)).toBe(false);
});
test('windowed evidence reports its coverage and keeps stable source cue IDs', async () => {
    const f = fixture(), d = await buildCollabDossier(f.sessionPath, f.dossierPath, f.io, { start: 1, end: 1.9 });
    expect(d.rows.map(r => r.id)).toEqual(['peer:S1', 'peer:D1']);
    const { sha256, ...content } = d; expect(sha256).toBe(jsonHash(content));
});
