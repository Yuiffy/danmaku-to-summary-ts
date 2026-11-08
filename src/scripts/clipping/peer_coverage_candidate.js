'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { randomUUID } = crypto;
const asr = require('../asr/asr_backends');
const { writeJsonAtomic } = require('./candidate_subtitles');

function arg(name) {
    const index = process.argv.indexOf(name);
    return index < 0 ? undefined : process.argv[index + 1];
}
function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function fail(message) { throw new Error(message); }

async function main() {
    const id = arg('--id');
    if (!/^[1-9]\d{0,8}$/u.test(String(id || ''))) fail('视频 ID 无效');
    const root = path.resolve(__dirname, '../../..');
    const registryPath = path.join(root, 'data/runtime/clip_upload_registry.json');
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    const clip = registry.clips?.[id];
    if (!clip) fail('视频不存在');
    if (['uploaded', 'queued', 'uploading', 'processing', 'cancelling', 'excluded', 'cancelled'].includes(clip.status)) {
        fail('已投稿或正在投稿的视频不能手工触发同题核查');
    }
    if (typeof clip.metadataPath !== 'string' || !fs.existsSync(clip.metadataPath)) fail('候选元数据不存在');
    const metadataPath = path.resolve(clip.metadataPath);
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    const source = metadata.source || {};
    const sourceSrt = source.srtPath || clip.sourceSrtPath;
    const sourceMedia = source.mediaPath || clip.sourceMediaPath;
    const start = Number(metadata.window?.start ?? clip.start);
    const end = Number(metadata.window?.end ?? (start + Number(clip.duration || 0)));
    if (!sourceSrt || !sourceMedia || !fs.existsSync(sourceSrt) || !fs.existsSync(sourceMedia)
        || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) fail('候选源字幕、录播或时间范围不可用');
    const segments = asr.parseSrt(sourceSrt, 'peer_coverage').segments
        .filter(row => row.start >= start - 0.001 && row.end <= end + 0.001 && row.end > row.start && String(row.text || '').trim());
    if (!segments.length) fail('候选时间段没有完整源字幕，无法核查同题');
    const candidate = {
        id: '1', roomId: String(metadata.roomId || clip.roomId || ''), host: String(metadata.streamerName || clip.streamerName || ''),
        source: sourceMedia, start, end,
        title: String(metadata.copy?.title || metadata.candidate?.title || clip.title || '').slice(0, 200),
        cues: segments.map((row, index) => ({ id: `S${index + 1}`, start: row.start, end: row.end, text: row.text }))
    };
    if (!candidate.roomId || !candidate.host) fail('候选缺少房间或主播信息');
    const configLoader = require('../config-loader');
    const rootConfig = configLoader.getConfig();
    const runtime = require('../workflow-runtime').loadWorkflow('clipping/peerCoverageRuntime');
    const outputRoot = path.join(path.dirname(metadataPath), 'peer_coverage');
    const evidencePath = path.join(outputRoot, `manual-${id}-${randomUUID()}.json`);
    const enhancements = rootConfig.ownStreamClips?.enhancements || rootConfig.enhancements || {};
    const decisions = await runtime.runPeerCuration({
        candidates: [candidate], settings: rootConfig.clipCuration || {}, cookie: rootConfig.bilibili?.cookie || '',
        evidencePath, statePath: path.join(root, 'data/runtime/clip_peer_support.json'), support: true,
        skipEditorialAssessment: true, rerankPeers: true
    }, async (phase, prompt) => {
        if (rootConfig.ai?.text?.enabled === false) fail('AI 文本能力已关闭');
        // Keep the manual command compatible with an already activated workflow
        // release that predates skipEditorialAssessment. The older runtime will
        // still ask for an assessment, so answer with the explicit operator
        // override and continue to deterministic Bilibili searches.
        if (String(phase).startsWith('assess-')) return JSON.stringify({ worthPublishing: true,
            score: 90, reason: '人工触发同题核查，跳过独立发布价值初筛', queries: [] });
        return (await require('./enhancement_runner').requestStage(
            { ...enhancements.stageDefaults, ...enhancements.stages?.selection }, enhancements.budget,
            { roomId: candidate.roomId, sessionId: metadata.source?.srtPath || metadataPath }, `manual-curation-${phase}`, prompt)).text;
    });
    const decision = decisions[0];
    if (!decision) fail('同题核查没有返回结果');
    const sourceSrtSha256 = sha256(sourceSrt);
    const evidenceSha256 = sha256(evidencePath);
    const curation = {
        version: 1, ...decision,
        ...(decision.status === 'original' ? {
            status: 'needs_review',
            reason: `人工触发同题核查未确认同题；${decision.reason}`
        } : {}),
        manualCheck: true, evidencePath, evidenceSha256, sourceSrtSha256,
        sourceMediaPath: sourceMedia, sourceWindow: { start, end }
    };
    metadata.curation = curation;
    if (metadata.publication?.curation || curation.status === 'covered') {
        metadata.publication = { ...metadata.publication, curation,
            ...(curation.status === 'covered' ? { selected: false, reason: 'curation_covered' } : {}) };
    }
    writeJsonAtomic(metadataPath, metadata);
    process.stdout.write(JSON.stringify({ id: String(id), status: curation.status, reason: curation.reason, evidencePath,
        peer: curation.peer?.bvid || null, support: curation.support || null }) + '\n');
}

if (require.main === module) main().catch(error => { console.error(error.message || '手工同题核查失败'); process.exitCode = 1; });
module.exports = { main };
