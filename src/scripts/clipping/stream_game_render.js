'use strict';
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { execFile } = require('child_process');
const asr = require('../asr/asr_backends');
const { fileDigest, sourceSnapshot } = require('./source_snapshot');
const { writeJsonAtomic } = require('./candidate_subtitles');
const { createClipResourceAdaptiveScheduler } = require('./resource_scheduler');
const { renderGamePart, gameCover } = require('./stream_game_media');
const { verifyGame, PROTOCOL_VERSION, mediaSettings } = require('./stream_game_verification');
const { restoreFrameNamedChapters } = require('./stream_game_names');
const { repairUnsupportedChapters } = require('./stream_game_editorial');
const { buildParts, sha, includedRanges, mergeEvents } = require('./stream_game_plan');
const execFileAsync = promisify(execFile);
const scripts = path.resolve(__dirname, '..');

async function accountCapabilities(options, directory) {
    if (options.capabilities) return options.capabilities;
    const state = path.join(directory, 'temp', 'upload-capabilities.json');
    const result = await execFileAsync('python', [path.join(scripts, 'bilibili_upload_capabilities.py'), '--state', state],
        { windowsHide: true, shell: false, timeout: 120000, maxBuffer: 1024 * 1024 });
    return JSON.parse(result.stdout.trim());
}
function singleParts(events, config, capabilities) {
    const max = Math.min(config.maxSingleVideoSeconds || 3600, capabilities.maxVideoSeconds - 60);
    if (!(max > 0)) throw new Error('Invalid account game duration limit');
    const result = [];
    for (const event of events) for (const range of includedRanges(event)) {
        const count = Math.max(1, Math.ceil((range.end - range.start) / max));
        const minimum = Math.min(600, (range.end - range.start) / count * .6);
        let start = range.start;
        for (let i = 0; i < count; i++) {
            const remaining = count - i - 1, target = (range.end - start) / (remaining + 1);
            const ideal = start + target, lower = Math.max(start + minimum, range.end - remaining * max);
            const upper = Math.min(start + max, range.end - remaining * minimum);
            const chapter = event.chapters.filter(c => c.start >= lower && c.start <= upper
                && Math.abs(c.start - ideal) <= Math.min(900, target * .35))
                .sort((a, b) => Math.abs(a.start - ideal) - Math.abs(b.start - ideal))[0];
            const end = remaining === 0 ? range.end : chapter?.start ?? ideal;
            const chapters = event.chapters.filter(c => c.start >= start && c.start < end);
            const leading = [...event.chapters].reverse().find(c => c.start <= start) || { title: '游戏开始', description: '进入本场游戏。' };
            result.push({ activityId: event.id, gameId: event.gameId, start, end, duration: end - start,
                title: `${leading.title}${count > 1 ? `（${i + 1}/${count}）` : ''}`,
                description: chapters.map(c => c.description).join(' '), chapters: [{ ...leading, start }, ...chapters.filter(c => c.start > start + .01)] });
            start = end;
        }
    }
    return result;
}

async function registerBundles(bundles, manifestPath, plan, options, config) {
    if (options.registerUpload === false || !bundles.length) return;
    const result = await execFileAsync('python', [path.join(scripts, 'clip_upload_registry.py'), 'import-json', '--manifest', manifestPath, '--include-pending'],
        { windowsHide: true, shell: false, timeout: 600000, maxBuffer: 1024 * 1024 });
    const registered = JSON.parse(result.stdout.split('REGISTRY_RESULT:')[1].trim());
    const ids = Object.values(registered.clipIdsByReviewIndex);
    const pendingIds = Object.entries(registered.clipIdsByReviewIndex)
        .filter(([index]) => !['uploaded', 'queued', 'uploading'].includes(registered.clipStatusByReviewIndex[index])).map(([, id]) => id);
    if (options.enqueue || config.autoUpload) {
        if (bundles.some(row => !row.uploadReady)) throw new Error('Game upload cannot be queued before content review');
        if (pendingIds.length) await execFileAsync('python', [path.join(scripts, 'clip_upload_registry.py'), 'enqueue', '--ids', pendingIds.join(','), '--timeout-seconds', '14400',
            '--batch-size', '1', '--note', options.authorizationNote || config.authorizationNote],
        { windowsHide: true, shell: false, timeout: 600000, maxBuffer: 1024 * 1024 });
    }
    plan.uploadIds = ids;
}

function renderedResult(plan, files, bundles) {
    return { status: 'rendered', manifestPath: plan.uploadManifestPath, planPath: files.plan, submissions: bundles.length,
        parts: bundles.reduce((n, row) => n + row.output.parts.length, 0), uploadIds: plan.uploadIds || [] };
}
function clock(seconds) { const n = Math.max(0, Math.floor(seconds)); return `${String(Math.floor(n / 3600)).padStart(2, '0')}:${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`; }
function publicCopy(plan, game, parts, episode, submission, submissions) {
    const chapters = parts.flatMap(p => p.chapters || [{ title: p.title, ...p.chapter }]);
    const unique = [...new Set(chapters.map(c => c.title))];
    const labels = unique.filter(t => !/开始|启动|设置|探索与|游戏探索/u.test(t));
    const normalize = value => String(value || '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
    const nameKeys = new Set(), named = [];
    for (const kind of ['boss', 'location']) for (const chapter of chapters.filter(c => c.kind === kind && c.nameEvidence)) {
        const key = normalize(chapter.nameEvidence);
        if (nameKeys.has(key)) continue;
        nameKeys.add(key); named.push(chapter.title.length <= 24 ? chapter.title : String(chapter.nameEvidence).replace(/\s+/gu, ''));
    }
    const phaseLabels = (labels.length ? labels : unique).filter(label => ![...nameKeys].some(key => normalize(label).includes(key)));
    const focusLabels = [...new Set([...named, ...phaseLabels])], selected = [];
    for (const label of focusLabels) {
        if (selected.length === 2) break;
        if ([...selected, label].join('、').length <= 24) selected.push(label);
    }
    const focus = selected.join('、') || '探索与推进';
    const title = `${game.name} 第${String(episode).padStart(2, '0')}集${submissions > 1 ? `（${submission}/${submissions}）` : ''}｜${focus} ${plan.recordedAt.slice(0, 10)}`;
    const lines = [`${plan.streamerName}《${game.name}》直播游玩记录。`, `直播日期：${plan.recordedAt}；直播标题：${plan.streamTitle.replace(/_merged(?:_best_effort)?$/u, '')}。`,
        '保留原始游戏音画、探索和挑战过程。中文字幕可在播放器中开关。'];
    if (parts.length > 1) lines.push(...parts.map((p, i) => `P${i + 1} ${p.title}`));
    else lines.push('本集时间轴：', ...parts[0].chapters.map(c => `${clock(c.start - parts[0].start)} ${c.title}`));
    if (lines.join('\n').length > 1900) throw new Error('Game description needs a shorter chapter list');
    return { title, description: lines.join('\n'), coverText: `${game.name}\n第${episode}集` };
}
function clippedCues(segments, part) {
    return segments.filter(c => c.end > part.start && c.start < part.end).map(c => ({ ...c,
        start: Math.max(0, c.start - part.start), end: Math.min(part.actualDuration, c.end - part.start) }))
        .filter(c => c.end > c.start && c.text.trim());
}
function reserveEpisode(gameId, sessionId, recordedAt, number, file = path.resolve(scripts, '../../data/runtime/stream_game_episodes.json')) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lock = file + '.lock';
    let fd;
    try { fd = fs.openSync(lock, 'wx'); fs.writeSync(fd, String(process.pid)); }
    catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const pid = Number(fs.readFileSync(lock, 'utf8'));
        let alive = Number.isSafeInteger(pid) && pid > 0;
        if (alive) { try { process.kill(pid, 0); } catch (e) { alive = e.code === 'EPERM'; } }
        if (alive || Date.now() - fs.statSync(lock).mtimeMs < 30000) throw new Error('Game episode registry is busy; retry without changing any episode numbers');
        fs.unlinkSync(lock);
        return reserveEpisode(gameId, sessionId, recordedAt, number, file);
    }
    try {
        const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, games: {} };
        const rows = state.games[gameId] ||= [];
        const old = rows.find(r => r.sessionId === sessionId);
        if (old) { if (number && old.number !== number) throw new Error('Game episode number is already bound'); return old.number; }
        const next = number || Math.max(0, ...rows.map(r => r.number)) + 1;
        if (!Number.isSafeInteger(next) || next <= 0 || rows.some(r => r.number === next)) throw new Error('Duplicate or invalid game episode');
        rows.push({ sessionId, recordedAt, number: next }); writeJsonAtomic(file, state); return next;
    } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

async function renderGames(plan, options, config, files) {
    if (JSON.stringify(sourceSnapshot({ source: options })) !== JSON.stringify(plan.source)) throw new Error('Game source changed before rendering');
    if (plan.status === 'rendered' && plan.uploadManifestPath) {
        // A policy change must not republish a previously completed source.
        const manifest = JSON.parse(fs.readFileSync(plan.uploadManifestPath, 'utf8'));
        const bundles = manifest.clips.map(c => JSON.parse(fs.readFileSync(c.metadataPath, 'utf8')));
        await registerBundles(bundles, plan.uploadManifestPath, plan, options, config);
        writeJsonAtomic(files.plan, plan);
        return renderedResult(plan, files, bundles);
    }
    if (Number.isFinite(plan.renderDurationLimit) && plan.renderDurationLimit > 0) config = { ...config,
        maxSingleVideoSeconds: Math.min(config.maxSingleVideoSeconds || 3600, plan.renderDurationLimit),
        maxPartSeconds: Math.min(config.maxPartSeconds, plan.renderDurationLimit),
        targetPartSeconds: Math.min(config.targetPartSeconds, plan.renderDurationLimit) };
    if (!plan.events.some(e => e.verification)) plan.events = mergeEvents(plan.events);
    if (!plan.events.length) return { status: 'no_gameplay', planPath: files.plan };
    const root = options.config, capabilities = await accountCapabilities(options, files.directory);
    if (!capabilities.collectionAllowed || !capabilities.externalSubtitlesAllowed) throw new Error('Game collection/subtitle account permissions are unavailable');
    for (const event of plan.events) {
        const method = options.boundaryEvidenceMethod || config.ai.boundaryEvidenceMethod || 'native_audio';
        if ([3, 4].includes(event.verification?.version) && event.verification.protocolVersion === PROTOCOL_VERSION
            && (event.verification.evidenceMethod || 'native_audio') === method
            && ['keep', 'exclude'].includes(event.verification.decision)) continue;
        await restoreFrameNamedChapters(event, plan, options, config, files, mediaSettings(root, config, 'frames'));
        event.verification = await (options.verify || verifyGame)(event, plan, options, config, files);
        if (event.verification.decision === 'uncertain' && (event.verification.frameObservations || []).some(f => f.activity === 'gameplay')
            && await repairUnsupportedChapters(event, plan, event.verification, options, files, mediaSettings(root, config, 'frames'))) {
            // A proposal never clears the gate: rerun original media review with the revised copy.
            writeJsonAtomic(files.plan, plan);
            event.verification = await (options.verify || verifyGame)(event, plan, options, config, files);
        }
        if (event.verification.decision === 'keep') {
            event.start = event.verification.start; event.end = event.verification.end;
            event.startObserved = true; event.endObserved = true; event.reviewIssues = [];
            event.chapters = event.chapters.filter(c => c.start >= event.start && c.start < event.end);
        }
        writeJsonAtomic(files.plan, plan);
    }
    const accepted = plan.events.filter(e => e.verification?.decision === 'keep');
    const uncertain = plan.events.filter(e => e.verification?.decision === 'uncertain');
    if (uncertain.length) throw new Error(`Game media review unresolved: ${uncertain.map(e => e.verification.reason).join('; ')}`);
    if (!accepted.length) return { status: 'no_verified_gameplay', planPath: files.plan };
    const allParts = capabilities.multipartAllowed ? buildParts(accepted, config) : singleParts(accepted, config, capabilities);
    const signature = sha({ source: plan.source, verified: accepted, allParts, capabilities: { multipartAllowed: capabilities.multipartAllowed,
        maxFileBytes: capabilities.maxFileBytes, maxVideoSeconds: capabilities.maxVideoSeconds }, collections: config.games.map(g => g.collection) });
    const directory = path.join(files.directory, signature.slice(0, 16)); fs.mkdirSync(directory, { recursive: true });
    const scheduler = (options.scheduler || createClipResourceAdaptiveScheduler)({ ownConfig: root.ownStreamClips || {}, rootConfig: root });
    const segments = asr.parseSrt(options.srtPath).segments;
    const bundles = [];
    let shorterLimit;
    try {
        for (const game of config.games) {
            const gameParts = allParts.filter(p => p.gameId === game.id);
            if (!gameParts.length) continue;
            const episode = reserveEpisode(game.id, plan.sessionId, plan.recordedAt, options.episode, options.episodeRegistryPath);
            const batches = capabilities.multipartAllowed
                ? Array.from({ length: Math.ceil(gameParts.length / config.maxPartsPerSubmission) }, (_, i) => gameParts.slice(i * config.maxPartsPerSubmission, (i + 1) * config.maxPartsPerSubmission))
                : gameParts.map(p => [p]);
            for (const [index, batch] of batches.entries()) {
                const stem = `${game.id}_E${String(episode).padStart(3, '0')}_${index + 1}`;
                const metadataPath = path.join(directory, stem + '.json');
                if (fs.existsSync(metadataPath)) {
                    const old = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
                    if (old.renderSignature === signature && old.output.parts.every(p => fs.existsSync(p.mediaPath) && fs.existsSync(p.srtPath)
                        && fs.statSync(p.mediaPath).size === p.bytes && fileDigest(p.mediaPath) === p.sha256 && fileDigest(p.srtPath) === p.srtSha256)) { bundles.push(old); continue; }
                    if (old.uploadReady) throw new Error('Published/reviewed game media changed; preserve the version and prepare a revision');
                }
                const parts = [];
                for (const [i, part] of batch.entries()) {
                    const outputPath = path.join(directory, `${stem}_P${String(i + 1).padStart(3, '0')}.mp4`);
                    const lease = await scheduler.acquire(); let rendered;
                    try { rendered = await (options.renderPart || renderGamePart)(options.mediaPath, part, outputPath, root, lease.profile); }
                    finally { lease.release(); }
                    if (rendered.bytes > capabilities.maxFileBytes) {
                        shorterLimit = Math.floor(Math.min(part.duration / 2, part.duration * capabilities.maxFileBytes / rendered.bytes * .85));
                        if (shorterLimit < 1 || (options.sizingAttempts || 0) >= 8) throw new Error('Game source still exceeds the account file limit after shorter splits');
                        // Only remove the just-created oversized export; the recording is retained.
                        fs.unlinkSync(outputPath);
                        const error = new Error('Game export needs shorter intervals at the same quality');
                        error.code = 'GAME_EXPORT_TOO_LARGE';
                        throw error;
                    }
                    const srtPath = path.join(directory, `${stem}_P${String(i + 1).padStart(3, '0')}.srt`);
                    const cues = clippedCues(segments, rendered);
                    if (!cues.length) throw new Error('No usable source subtitles for this game P');
                    asr.writeSrt({ segments: cues }, srtPath, { strip_punctuation: false, max_chars_per_line: 100000, max_duration: 100000,
                        gap_mode: 'none', lead_in: 0, tail_out: 0 });
                    parts.push({ ...rendered, srtPath, srtSha256: fileDigest(srtPath), subtitleCues: cues.length,
                        title: `第${String(episode).padStart(2, '0')}集 ${part.title}` });
                }
                const coverPath = path.join(directory, stem + '.cover.jpg');
                const lease = await scheduler.acquire();
                try { await (options.cover || gameCover)(parts[0], coverPath, root); } finally { lease.release(); }
                const selected = accepted.filter(e => batch.some(p => p.activityId === e.id)).map(e => {
                    const ps = batch.filter(p => p.activityId === e.id), start = ps[0].start, end = ps.at(-1).end;
                    return { ...e, sourceWindow: { start: e.start, end: e.end }, start, end,
                        excludedRanges: e.excludedRanges.filter(r => r.end > start && r.start < end).map(r => ({ ...r, start: Math.max(start, r.start), end: Math.min(end, r.end) })) };
                });
                const row = { version: 1, type: 'stream_game_submission', kind: 'games', gameId: game.id,
                    roomId: plan.roomId, streamerName: plan.streamerName, episode, recordedAt: plan.recordedAt,
                    source: { mediaPath: options.mediaPath, srtPath: options.srtPath, xmlPath: options.xmlPath || null }, sourceSnapshot: plan.source,
                    planSignature: plan.signature, planPath: files.plan, renderSignature: signature, coverage: plan.coverage,
                    visualTimeline: plan.visualTimeline, activities: selected,
                    window: { start: batch[0].start, end: batch.at(-1).end, duration: batch.reduce((n, p) => n + p.duration, 0) },
                    copy: publicCopy(plan, game, parts, episode, index + 1, batches.length), output: { metadataPath, mediaPath: parts[0].mediaPath,
                        srtPath: parts[0].srtPath, coverPath, parts }, coverSha256: fileDigest(coverPath), uploadReady: false,
                    upload: { prefix: '【小岁】', tid: game.tid || 17, tags: game.tags, roomId: plan.roomId, streamerName: plan.streamerName,
                        source: `${plan.streamerName} 直播《${plan.streamTitle}》${plan.recordedAt}`, collectionSeasonId: game.collection?.seasonId || null,
                        collectionSectionId: game.collection?.sectionId || null, externalSubtitles: true, subtitleLanguage: 'zh-CN' },
                    accountCapabilities: capabilities, gameReview: { status: 'pending' } };
                writeJsonAtomic(metadataPath, row);
                const note = options.authorizationNote || config.authorizationNote;
                if (note) {
                    await execFileAsync('python', [path.join(scripts, 'stream_game_review.py'), '--metadata', metadataPath,
                        '--authorization-note', note, ...(config.autoUpload ? ['--automatic'] : [])],
                    { windowsHide: true, shell: false, timeout: 600000, maxBuffer: 1024 * 1024 });
                    Object.assign(row, JSON.parse(fs.readFileSync(metadataPath, 'utf8')));
                }
                bundles.push(row);
            }
        }
    } catch (error) {
        if (error.code !== 'GAME_EXPORT_TOO_LARGE') throw error;
    } finally { await scheduler.stop?.(); }
    if (shorterLimit) {
        plan.renderDurationLimit = shorterLimit;
        plan.status = 'planned'; writeJsonAtomic(files.plan, plan);
        console.log(`[GAME_SHORTER_SPLIT] ${plan.recordedAt} maximum ${shorterLimit}s; encoding quality unchanged`);
        return renderGames(plan, { ...options, sizingAttempts: (options.sizingAttempts || 0) + 1 }, config, files);
    }
    if (JSON.stringify(sourceSnapshot({ source: options })) !== JSON.stringify(plan.source)) throw new Error('Game source changed while rendering');
    const manifestPath = path.join(directory, 'UPLOAD_MANIFEST.json');
    writeJsonAtomic(manifestPath, { version: 1, type: 'bilibili_clip_upload_manifest', roomId: plan.roomId, reviewPath: files.review,
        planPath: files.plan, clips: bundles.map((row, i) => ({ reviewIndex: i + 1, metadataPath: row.output.metadataPath })) });
    fs.writeFileSync(files.review, `# 游戏完整录播\n\n来源：${options.mediaPath}\n全场文字覆盖：${plan.coverage.status}\n账号多 P 权限：${capabilities.multipartAllowed}\n\n`
        + bundles.map(row => `${row.copy.title}\n${row.copy.description}\n元数据：${row.output.metadataPath}\n`).join('\n'), 'utf8');
    await registerBundles(bundles, manifestPath, plan, options, config);
    plan.status = 'rendered'; plan.renderSignature = signature; plan.uploadManifestPath = manifestPath; writeJsonAtomic(files.plan, plan);
    return renderedResult(plan, files, bundles);
}
module.exports = { accountCapabilities, singleParts, publicCopy, clippedCues, reserveEpisode, renderGames };
