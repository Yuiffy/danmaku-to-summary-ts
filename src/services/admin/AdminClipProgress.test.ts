import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AdminClipProgress, clipActivity, clipProgressItem } from './AdminClipProgress';
import { atomicJson } from './AdminFiles';
import { readClipVideoMedia, readClipVideos } from './AdminClipArtifacts';

const now = Date.parse('2026-10-29T17:00:00Z'), at = (offset: number) => new Date(now + offset).toISOString();
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-clip-progress-')); roots.push(root);
  const directory = path.join(root, 'queue');
  atomicJson(path.join(root, 'config/production.json'), { backgroundClipQueue: { directory } });
  atomicJson(path.join(directory, 'worker.lock'), { pid: 123 });
  const write = (id: string, kind = 'pending', extra = {}) => {
    const payloadPath = path.join(root, `${id}.payload.json`), logPath = path.join(root, `${id}.log`);
    const entry = { payloadPath, logPath, roomId: '25788785', enqueuedAt: at(-600000), ...extra };
    atomicJson(path.join(directory, `${id}.${kind}.json`), entry);
    atomicJson(payloadPath, { originalMediaPath: 'D:\\recordings\\25788785_岁己SUI\\2026_10_29\\录制-一场直播_merged.flv', context: { streamerName: '小岁' } });
    return { payloadPath, logPath };
  };
  return { root, directory, write, reader: new AdminClipProgress(root, { now: () => now, isAlive: () => true }) };
}
it('reads running stages and current-job activity without modifying queue, locks or source files', () => {
  const f = fixture(), source = f.write('002', 'working');
  atomicJson(`${source.payloadPath}.progress.json`, { pid: 123, status: 'running', stage: 'own', completed: { topics: [] }, updatedAt: at(-300000) });
  fs.writeFileSync(source.logPath, `[${at(-1000)}] [LOG] [WAIT] 正在通过provider API生成文本... secret-token\n`);
  f.write('001');
  f.write('003', 'pending', { nextAttemptAt: now + 60000, attempts: 1 });
  const files = [path.join(f.directory, '002.working.json'), path.join(f.directory, 'worker.lock'), source.logPath, `${source.payloadPath}.progress.json`];
  const before = files.map(file => fs.readFileSync(file, 'utf8'));
  const result = f.reader.status();
  expect(result).toMatchObject({ worker: 'online', activeJobs: 1, queuedJobs: 2, unreadableJobs: 0 });
  expect(result.queue.map(task => task.id)).toEqual(['002', '001', '003']);
  expect(result.queue[0]).toMatchObject({ streamerName: '小岁', title: '录制-一场直播', stage: 'own', completedStages: ['topics'],
    status: 'processing', stale: false, activity: { label: '等待 AI 处理结果', at: at(-1000) } });
  expect(result.queue[1].activity).toBeUndefined();
  expect(result.queue[2]).toMatchObject({ status: 'retry_wait', attempts: 1, nextAttemptAt: at(60000) });
  expect(JSON.stringify(result)).not.toMatch(/secret-token|provider|payloadPath|D:|\.log/);
  expect(files.map(file => fs.readFileSync(file, 'utf8'))).toEqual(before);
});
it('reports dead or replaced workers without presenting old stages as active execution', () => {
  const f = fixture(), source = f.write('001', 'working');
  atomicJson(`${source.payloadPath}.progress.json`, { pid: 123, stage: 'own', completed: {}, updatedAt: at(-1000) });
  expect(new AdminClipProgress(f.root, { now: () => now, isAlive: () => false }).status())
    .toMatchObject({ worker: 'offline', activeJobs: 0, queue: [{ status: 'interrupted', stale: true }] });
  atomicJson(path.join(f.directory, 'worker.lock'), { pid: 456 });
  expect(f.reader.status()).toMatchObject({ worker: 'online', activeJobs: 0, queue: [{ status: 'interrupted' }] });
});
it('shows missing progress and logs explicitly and retains a bounded list of ended jobs', () => {
  const f = fixture(); f.write('006', 'working');
  for (let id = 1; id <= 5; id++) {
    f.write(`00${id}`, id === 5 ? 'failed' : 'done');
    fs.utimesSync(path.join(f.directory, `00${id}.${id === 5 ? 'failed' : 'done'}.json`), now / 1000 + id, now / 1000 + id);
  }
  const result = f.reader.status();
  expect(result.queue[0]).toMatchObject({ logAvailable: false, progressAvailable: false, stale: true });
  expect(result.queue[0].stage).toBeUndefined();
  expect(result.recent.map(task => [task.id, task.status])).toEqual([['005', 'failed'], ['004', 'done'], ['003', 'done']]);
});
it('marks older activity stale and ignores unknown, previous-stage and future provider logs', () => {
  const log = [`[${at(-600000)}] [LOG] Review list: previous-stage`, `[${at(-300000)}] [WARN] AI clip validation rejected 1/3: private-copy`,
    `[${at(-1000)}] [LOG] Authorization: secret`, `[${at(1000)}] [LOG] Review list: future`].join('\n');
  const result = clipProgressItem({ id: 'a', kind: 'working', entry: {}, progress: { stage: 'own', updatedAt: at(-500000), completed: { topics: [] } }, log }, 'online', 123, now);
  expect(result).toMatchObject({ stale: true, activity: { label: '候选证据校验与修正', at: at(-300000) } });
  expect(clipActivity(log, at(-200000), now)).toBeUndefined();
  expect(JSON.stringify(result)).not.toMatch(/private-copy|secret|future|previous-stage/);
});
it('does not invent percentages or progress from a queue entry alone', () => {
  const f = fixture(); f.write('001');
  expect(f.reader.status().queue[0]).toMatchObject({ status: 'pending', completedStages: [], progressAvailable: false });
  expect(JSON.stringify(f.reader.status())).not.toMatch(/percent|etaSeconds/);
});
it('reads a bounded log tail and excludes unrelated model payloads', () => {
  const f = fixture(), source = f.write('001', 'working');
  fs.writeFileSync(source.logPath, `[${at(-1000)}] [LOG] Review list: outside-tail\n` + 'x'.repeat(300000) + '\n' + `[${at(-500)}] [LOG] API调用成功\n`);
  expect(f.reader.status().queue[0].activity).toEqual({ label: '收到 AI 处理结果', at: at(-500) });
});
it('handles an absent queue as idle and warns about malformed entries without claiming it is empty', () => {
  const f = fixture(); fs.writeFileSync(path.join(f.directory, '001.working.json'), '{');
  expect(f.reader.status()).toMatchObject({ activeJobs: 0, unreadableJobs: 1 });
  const missing = path.join(f.root, 'missing');
  expect(new AdminClipProgress(f.root, { queueDirectory: missing }).status()).toMatchObject({ worker: 'offline', queue: [] });
  expect(fs.existsSync(missing)).toBe(false);
});
it('uses the same production config and queue-directory precedence as the worker', () => {
  const f = fixture(); f.write('001');
  atomicJson(path.join(f.root, 'config/default.json'), { clipTopics: { backgroundQueue: { directory: 'wrong' } } });
  atomicJson(path.join(f.root, 'config/production.json'), { clipTopics: { backgroundQueue: { directory: f.directory } }, backgroundClipQueue: { directory: 'wrong' } });
  expect(f.reader.status().queue).toHaveLength(1);
  expect(new AdminClipProgress(f.root, { queueDirectory: 'missing' }).status().queue).toHaveLength(0);
});

function videoFixture() {
  const f = fixture(), media = path.join(f.root, 'source.flv'), directory = path.join(f.root, 'own_stream_fun_clips');
  const progress = { source: { media }, startedAt: at(-500000), updatedAt: at(-1000), status: 'complete', total: 4,
    entries: [{ index: 0, status: 'rendered_for_review', metadataPath: path.join(directory, 'one.json') },
      { index: 1, status: 'needs_review' }, { index: 2, status: 'failed' }, { index: 3, status: 'rendering' }] };
  const file = path.join(directory, 'PLAN_PROGRESS.json');
  atomicJson(file, progress);
  atomicJson(progress.entries[0].metadataPath!, { source: { mediaPath: media }, window: { index: 1 }, qaRequired: true,
    qaResult: { status: 'passed' }, secret: 'do-not-return' });
  return { ...f, media, directory, progress, file, read: () => readClipVideos({ originalMediaPath: media }, {}, at(-600000), now) };
}
it('shows processed candidates separately from generated videos, failures and final review', () => {
  const f = videoFixture(), before = fs.readFileSync(f.file, 'utf8');
  expect(f.read()).toMatchObject({ total: 4, processed: 3, rendered: 1, needsReview: 1, failed: 1, phase: 'final_review',
    items: [{ index: 1, state: 'rendered', review: 'passed' }, { index: 2, state: 'needs_review' }, { index: 3, state: 'failed' }, { index: 4, state: 'rendering' }] });
  expect(JSON.stringify(f.read())).not.toMatch(/do-not-return|source.flv|metadataPath/);
  expect(fs.readFileSync(f.file, 'utf8')).toEqual(before);
});
it('rejects other recordings, prior runs, future timestamps and malformed candidate totals', () => {
  const f = videoFixture();
  for (const patch of [{ source: { media: path.join(f.root, 'other.flv') } }, { startedAt: at(-700000) },
    { updatedAt: at(1000) }, { total: 5 }, { entries: [...f.progress.entries.slice(0, 3), f.progress.entries[0]] }]) {
    atomicJson(f.file, { ...f.progress, ...patch }); expect(f.read()).toBeUndefined();
  }
});
it('does not use metadata outside the output directory or bound to another source/index', () => {
  const f = videoFixture(), metadataPath = f.progress.entries[0].metadataPath!;
  for (const patch of [{ source: { mediaPath: 'other.flv' }, window: { index: 1 } },
    { source: { mediaPath: f.media }, window: { index: 2 } }]) {
    atomicJson(metadataPath, { ...patch, qaRequired: true, qaResult: { status: 'passed' } });
    expect(f.read()?.items[0].review).toBeUndefined();
  }
  atomicJson(f.file, { ...f.progress, entries: [{ ...f.progress.entries[0], metadataPath: path.join(f.root, 'outside.json') }, ...f.progress.entries.slice(1)] });
  expect(f.read()?.items[0].review).toBeUndefined();
});
it('reads archive-mapped output and gracefully omits unavailable production receipts', () => {
  const f = videoFixture(), archive = path.join(f.root, 'archive'), active = path.join(f.root, 'active');
  const media = path.join(archive, 'room', 'source.flv');
  atomicJson(path.join(active, 'room', 'custom', 'PLAN_PROGRESS.json'), { ...f.progress, source: { media } });
  expect(readClipVideos({ originalMediaPath: media }, { ownStreamClips: { archiveSourceRoot: archive,
    activeOutputRoot: active, outputDirName: 'custom' } }, at(-600000), now)?.total).toBe(4);
  expect(readClipVideos({ originalMediaPath: media }, {}, at(-600000), now)).toBeUndefined();
});
it('makes the first completed video playable while the next is still rendering, without approving or registering it', () => {
  const f = videoFixture(), metadata = f.progress.entries[0].metadataPath!, media = path.join(f.directory, 'first.mp4');
  fs.writeFileSync(media, 'first completed video');
  atomicJson(metadata, { source: { mediaPath: f.media }, window: { index: 1 }, copy: { title: '第一条' },
    qaRequired: true, qaResult: { status: 'passed' }, creativeResult: { status: 'edited' },
    editorialStyle: { status: 'completed' }, output: { mediaPath: media, burnedSubtitles: true } });
  const before = [f.file, metadata, media].map(file => fs.readFileSync(file));
  const first = f.read()!;
  expect(first).toMatchObject({ refined: 1, items: [{ title: '第一条', edition: 'precision', review: 'passed' }, {}, {}, { state: 'rendering' }] });
  expect(first.items[0].finalReview).toBeUndefined();
  const key = first.items[0].previewKey!;
  expect(key).toMatch(/^[a-f0-9]{64}$/u);
  const resolve = (index = 1, version = key) => readClipVideoMedia({ originalMediaPath: f.media }, {}, at(-600000), now, index, version);
  expect(resolve()).toBe(fs.realpathSync(media));
  expect(resolve(4)).toBeUndefined();
  expect(resolve(1, '0'.repeat(64))).toBeUndefined();
  expect(JSON.stringify(first)).not.toMatch(/first.mp4|metadataPath|source.flv/);
  expect([f.file, metadata, media].map(file => fs.readFileSync(file))).toEqual(before);
  const secondMetadata = path.join(f.directory, 'second.json'), secondMedia = path.join(f.directory, 'second.mp4');
  fs.writeFileSync(secondMedia, 'second completed video');
  atomicJson(secondMetadata, { source: { mediaPath: f.media }, window: { index: 4 },
    publicationReview: { status: 'approved' }, output: { mediaPath: secondMedia, burnedSubtitles: true } });
  f.progress.entries[3] = { index: 3, status: 'rendered_for_review', metadataPath: secondMetadata };
  atomicJson(f.file, f.progress);
  expect(f.read()?.items[3]).toMatchObject({ previewKey: expect.any(String), edition: 'initial', finalReview: 'passed' });
  fs.appendFileSync(media, 'updated revision');
  expect(resolve()).toBeUndefined();
  expect(f.read()?.items[0].previewKey).not.toBe(key);
  expect(fs.existsSync(path.join(f.root, 'data/runtime/clip_upload_registry.json'))).toBe(false);
});
it('rejects unfinished, failed, unbound, outside and symlink-escaped media from intermediate previews', () => {
  const f = videoFixture(), metadata = f.progress.entries[0].metadataPath!, media = path.join(f.directory, 'first.mp4');
  fs.writeFileSync(media, 'video');
  const base = { source: { mediaPath: f.media }, window: { index: 1 }, output: { mediaPath: media, burnedSubtitles: true } };
  for (const patch of [{ output: { ...base.output, burnedSubtitles: false } }, { output: { ...base.output, mediaError: 'failed' } },
    { source: { mediaPath: 'other.flv' } }, { window: { index: 2 } },
    { output: { ...base.output, mediaPath: path.join(f.root, 'outside.mp4') } }]) {
    atomicJson(metadata, { ...base, ...patch }); expect(f.read()?.items[0].previewKey).toBeUndefined();
  }
  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'escape.mp4'), 'private');
  const linked = path.join(f.directory, 'linked'); fs.symlinkSync(outside, linked, 'junction');
  atomicJson(metadata, { ...base, output: { ...base.output, mediaPath: path.join(linked, 'escape.mp4') } });
  expect(f.read()?.items[0].previewKey).toBeUndefined();
  atomicJson(metadata, base);
  atomicJson(f.file, { ...f.progress, entries: [{ ...f.progress.entries[0], status: 'rendering' }, ...f.progress.entries.slice(1)] });
  expect(f.read()?.items[0].previewKey).toBeUndefined();
});
it('follows only this run’s source-bound final revision and keeps quality review separate from publication review', () => {
  const f = videoFixture(), revision = path.join(f.directory, 'highlight-first-revision', 'metadata.json');
  const media = path.join(path.dirname(revision), 'rendered.mp4');
  const state = { type: 'own_stream_review_state', metadata: { source: { mediaPath: f.media }, processingStats: { startedAt: at(-500050) } },
    entries: [{ reviewIndex: 1, metadataPath: revision }] };
  atomicJson(path.join(f.directory, 'REVIEW_STATE.json'), state);
  atomicJson(revision, { source: { mediaPath: f.media }, window: { index: 1 }, qaRequired: true, qaResult: { status: 'passed' },
    publicationReview: { status: 'needs_review' }, editorialTimeline: { version: 1 }, editorialStyle: { status: 'completed' },
    output: { mediaPath: media, burnedSubtitles: true } });
  fs.writeFileSync(media, 'front-loaded revision');
  expect(f.read()?.items[0]).toMatchObject({ edition: 'highlight_first', review: 'passed', finalReview: 'failed', previewKey: expect.any(String) });
  atomicJson(path.join(f.directory, 'REVIEW_STATE.json'), { ...state, metadata: { ...state.metadata, processingStats: { startedAt: at(-700000) } } });
  expect(f.read()?.items[0].previewKey).toBeUndefined();
  atomicJson(path.join(f.directory, 'REVIEW_STATE.json'), { ...state, metadata: { ...state.metadata, source: { mediaPath: 'other.flv' } } });
  expect(f.read()?.items[0].previewKey).toBeUndefined();
});
it('describes the ordered ordinary stages and single-stage activity flows', () => {
  const base = { id: 'a', kind: 'working' as const, entry: {} };
  expect(clipProgressItem({ ...base, payload: {}, progress: { stage: 'own' } }, 'online', 1, now).steps)
    .toEqual(['topics', 'own', 'songs', 'games', 'watch']);
  expect(clipProgressItem({ ...base, payload: { activityOptions: {} }, progress: { stage: 'activity' } }, 'online', 1, now).steps)
    .toEqual(['activity']);
});
