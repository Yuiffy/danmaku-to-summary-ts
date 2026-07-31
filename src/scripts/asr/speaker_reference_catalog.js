const fs = require('fs');
const path = require('path');

const configLoader = require('../config-loader');

const DEFAULT_MANIFEST_PATH = path.join(process.cwd(), 'data', 'asr_speaker_refs', 'manifest.json');
const DEFAULT_REFS_DIR = path.join(process.cwd(), 'data', 'asr_speaker_refs');

function normalizeLabel(value) {
    return String(value || '').trim().toLocaleLowerCase('zh-CN');
}

function dedupeStrings(values = []) {
    const result = [];
    const seen = new Set();
    for (const value of values) {
        const text = String(value || '').trim();
        if (!text) continue;
        const normalized = normalizeLabel(text);
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        result.push(text);
    }
    return result;
}

function resolveProjectPath(inputPath) {
    const text = String(inputPath || '').trim();
    if (!text) return null;
    if (path.isAbsolute(text)) return text;
    return path.join(process.cwd(), text);
}

function loadManifest(manifestPath = DEFAULT_MANIFEST_PATH) {
    try {
        if (!fs.existsSync(manifestPath)) {
            return [];
        }
        const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        throw new Error(`读取 speaker reference manifest 失败: ${error.message}`);
    }
}

function saveManifest(entries, manifestPath = DEFAULT_MANIFEST_PATH) {
    const output = Array.isArray(entries) ? entries : [];
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
}

function collectConfiguredSpeakerReferences(config = configLoader.getConfig()) {
    const asrConfig = config?.asr || {};
    const refs = [];
    Object.values(asrConfig).forEach((backendConfig) => {
        if (!backendConfig || typeof backendConfig !== 'object') {
            return;
        }
        const items = Array.isArray(backendConfig.speaker_references) ? backendConfig.speaker_references : [];
        items.forEach((item) => {
            if (!item || typeof item !== 'object') {
                return;
            }
            refs.push({ ...item, source: 'config' });
        });
    });
    return refs;
}

function collectSpeakerLabels(streamer = {}) {
    return dedupeStrings([
        streamer.id,
        streamer.displayName,
        ...(Array.isArray(streamer.speakerLabels) ? streamer.speakerLabels : []),
        ...(Array.isArray(streamer.aliases) ? streamer.aliases : [])
    ]);
}

function buildReferenceCollectionIndex(config = configLoader.getConfig(), manifestPath = DEFAULT_MANIFEST_PATH) {
    const index = new Map();
    const seen = new Set();
    const add = (entry, source) => {
        if (!entry || typeof entry !== 'object') return;
        const speaker = String(entry.speaker || entry.label || '').trim();
        const audioPath = String(entry.audio_path || entry.path || '').trim();
        if (!speaker || !audioPath) return;
        const resolvedAudioPath = resolveProjectPath(audioPath);
        const normalizedEntry = {
            speaker,
            key: entry.key ? String(entry.key).trim() : null,
            audio_path: audioPath,
            resolvedAudioPath,
            exists: Boolean(resolvedAudioPath && fs.existsSync(resolvedAudioPath)),
            source,
            start_s: entry.start_s,
            end_s: entry.end_s,
            chunk_s: entry.chunk_s,
            max_chunks: entry.max_chunks,
            seconds: entry.seconds,
            source_count: entry.source_count,
            state: entry.state ? String(entry.state).trim() : null
        };
        const identity = [
            normalizeLabel(speaker),
            String(resolvedAudioPath || audioPath).toLocaleLowerCase('en-US'),
            entry.start_s ?? '',
            entry.end_s ?? ''
        ].join('|');
        if (seen.has(identity)) return;
        seen.add(identity);
        const labels = dedupeStrings([speaker]);
        labels.forEach((label) => {
            const key = normalizeLabel(label);
            if (!index.has(key)) {
                index.set(key, []);
            }
            index.get(key).push(normalizedEntry);
        });
    };

    loadManifest(manifestPath).forEach((entry) => add(entry, 'manifest'));
    collectConfiguredSpeakerReferences(config).forEach((entry) => add(entry, 'config'));
    return index;
}

function buildReferenceIndex(config = configLoader.getConfig(), manifestPath = DEFAULT_MANIFEST_PATH) {
    const collections = buildReferenceCollectionIndex(config, manifestPath);
    return new Map(
        [...collections.entries()]
            .filter(([, entries]) => entries.length > 0)
            .map(([label, entries]) => [label, entries[0]])
    );
}

function findReferencesForLabels(labels = [], config = configLoader.getConfig(), manifestPath = DEFAULT_MANIFEST_PATH) {
    const index = buildReferenceCollectionIndex(config, manifestPath);
    const references = [];
    const seen = new Set();
    for (const label of labels) {
        const matches = index.get(normalizeLabel(label)) || [];
        for (const match of matches) {
            const identity = [
                normalizeLabel(match.speaker),
                String(match.resolvedAudioPath || match.audio_path).toLocaleLowerCase('en-US'),
                match.start_s ?? '',
                match.end_s ?? ''
            ].join('|');
            if (seen.has(identity)) continue;
            seen.add(identity);
            references.push(match);
        }
    }
    return references;
}

function findReferenceForLabels(labels = [], config = configLoader.getConfig(), manifestPath = DEFAULT_MANIFEST_PATH) {
    return findReferencesForLabels(labels, config, manifestPath)[0] || null;
}

function getStreamerReferenceStatus(streamer = {}, config = configLoader.getConfig(), manifestPath = DEFAULT_MANIFEST_PATH) {
    const labels = collectSpeakerLabels(streamer);
    const references = findReferencesForLabels(labels, config, manifestPath);
    if (references.length === 0) {
        return {
            streamerId: streamer.id || null,
            displayName: streamer.displayName || streamer.id || 'unknown',
            labels,
            status: 'missing_manifest',
            reference: null,
            references: [],
            message: `未找到 ${streamer.displayName || streamer.id || 'unknown'} 的 speaker reference`
        };
    }
    const readyReferences = references.filter((reference) => reference.exists);
    if (readyReferences.length === 0) {
        return {
            streamerId: streamer.id || null,
            displayName: streamer.displayName || streamer.id || 'unknown',
            labels,
            status: 'missing_audio',
            reference: references[0],
            references,
            message: `speaker reference 音频不存在: ${references[0].audio_path}`
        };
    }
    return {
        streamerId: streamer.id || null,
        displayName: streamer.displayName || streamer.id || 'unknown',
        labels,
        status: 'ready',
        reference: readyReferences[0],
        references: readyReferences,
        message: ''
    };
}

function getRosterReferenceStatus(participants = [], config = configLoader.getConfig(), manifestPath = DEFAULT_MANIFEST_PATH) {
    const statuses = participants.map((participant) => getStreamerReferenceStatus(participant, config, manifestPath));
    const missing = statuses.filter((item) => item.status !== 'ready');
    return {
        status: missing.length === 0 ? 'ready' : (missing.length === statuses.length ? 'failed' : 'partial'),
        participants: statuses,
        missingStreamerIds: missing.map((item) => item.streamerId).filter(Boolean),
        readyStreamerIds: statuses.filter((item) => item.status === 'ready').map((item) => item.streamerId).filter(Boolean)
    };
}

function buildSpeakerReferencesForParticipants(participants = [], config = configLoader.getConfig(), manifestPath = DEFAULT_MANIFEST_PATH) {
    const statuses = participants
        .map((participant) => ({ participant, status: getStreamerReferenceStatus(participant, config, manifestPath) }))
        .filter((item) => item.status.reference && item.status.status === 'ready');
    const usedReferences = new Set();
    const references = [];
    for (const item of statuses) {
        const speakerReferences = item.status.references || [item.status.reference];
        for (const ref of speakerReferences) {
            if (!ref) continue;
            const identity = [
                normalizeLabel(ref.speaker),
                String(ref.audio_path).toLocaleLowerCase('en-US'),
                ref.start_s ?? '',
                ref.end_s ?? ''
            ].join('|');
            if (usedReferences.has(identity)) continue;
            usedReferences.add(identity);
            references.push({
                speaker: ref.speaker,
                audio_path: ref.audio_path,
                ...(ref.start_s !== undefined ? { start_s: ref.start_s } : {}),
                ...(ref.end_s !== undefined ? { end_s: ref.end_s } : {}),
                ...(ref.chunk_s !== undefined ? { chunk_s: ref.chunk_s } : {}),
                ...(ref.max_chunks !== undefined ? { max_chunks: ref.max_chunks } : {}),
                ...(ref.state ? { state: ref.state } : {})
            });
        }
    }
    return references;
}

function slugifySpeakerKey(value) {
    return String(value || '')
        .trim()
        .toLocaleLowerCase('en-US')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'speaker';
}

function registerCanonicalReference(options = {}, manifestPath = DEFAULT_MANIFEST_PATH) {
    const speaker = String(options.speaker || '').trim();
    const audioPath = String(options.audioPath || '').trim();
    if (!speaker) {
        throw new Error('prepare 需要 --speaker');
    }
    if (!audioPath) {
        throw new Error('prepare 需要 --audio-path');
    }
    const absoluteAudioPath = path.resolve(audioPath);
    if (!fs.existsSync(absoluteAudioPath)) {
        throw new Error(`audio-path 不存在: ${absoluteAudioPath}`);
    }
    const key = String(options.key || slugifySpeakerKey(speaker)).trim();
    const ext = path.extname(absoluteAudioPath) || '.wav';
    const targetFileName = `${key}${ext}`;
    const targetPath = path.join(DEFAULT_REFS_DIR, targetFileName);
    fs.mkdirSync(DEFAULT_REFS_DIR, { recursive: true });
    fs.copyFileSync(absoluteAudioPath, targetPath);

    const relativeAudioPath = path.relative(process.cwd(), targetPath).replace(/\\/g, '/');
    const entries = loadManifest(manifestPath);
    const nextEntry = {
        speaker,
        key,
        audio_path: relativeAudioPath,
        source_count: options.sourceCount !== undefined ? Number(options.sourceCount) : undefined,
        source_media: options.sourceMedia ? String(options.sourceMedia) : undefined,
        source_srt: options.sourceSrt ? String(options.sourceSrt) : undefined
    };

    const index = entries.findIndex((entry) => String(entry?.key || '').trim() === key);
    if (index >= 0) {
        entries[index] = { ...entries[index], ...nextEntry };
    } else {
        entries.push(nextEntry);
    }
    saveManifest(entries, manifestPath);

    return {
        speaker,
        key,
        audio_path: relativeAudioPath,
        resolvedAudioPath: targetPath
    };
}

module.exports = {
    DEFAULT_MANIFEST_PATH,
    collectConfiguredSpeakerReferences,
    collectSpeakerLabels,
    loadManifest,
    saveManifest,
    buildReferenceIndex,
    findReferencesForLabels,
    findReferenceForLabels,
    getStreamerReferenceStatus,
    getRosterReferenceStatus,
    buildSpeakerReferencesForParticipants,
    registerCanonicalReference,
    resolveProjectPath,
    normalizeLabel,
    dedupeStrings,
    slugifySpeakerKey
};
