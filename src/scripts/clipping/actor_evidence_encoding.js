'use strict';

function packActorEvidence(packets) {
    const audience = new Map();
    const source = packets[0]?.sourceSha256;
    const clipIds = new Set();
    const clips = packets.map(packet => {
        if (packet.sourceSha256 !== source || clipIds.has(packet.id)) throw new Error('Actor evidence batches require one source and unique clip IDs');
        clipIds.add(packet.id);
        const { audience: comments, ...data } = packet.data;
        for (const row of comments) {
            if (!/^D[1-9]\d*$/u.test(row.id) || !Number.isFinite(row.time) || typeof row.text !== 'string') throw new Error('Invalid actor audience evidence');
            const previous = audience.get(row.id);
            if (previous && (previous.time !== row.time || previous.text !== row.text)) throw new Error(`Conflicting actor audience evidence: ${row.id}`);
            audience.set(row.id, row);
        }
        return { ...data, audienceIds: comments.map(row => row.id) };
    });
    const counts = new Map();
    audience.forEach(row => counts.set(row.text, (counts.get(row.text) || 0) + 1));
    const texts = new Map();
    for (const [text, count] of counts) {
        const id = `T${texts.size + 1}`;
        const referenceCost = JSON.stringify({ ref: id }).length;
        const definitionCost = JSON.stringify([id, text]).length + 1;
        if (count > 1 && count * JSON.stringify(text).length > count * referenceCost + definitionCost) texts.set(text, id);
    }
    return { version: 1, clips,
        audienceColumns: ['id', 'time', 'textOrRef'],
        audienceRows: [...audience.values()].map(row => [row.id, row.time, texts.has(row.text) ? { ref: texts.get(row.text) } : row.text]),
        textDictionary: [...texts].map(([text, id]) => [id, text]) };
}

function unpackActorEvidence(packed) {
    if (packed?.version !== 1 || !Array.isArray(packed.clips) || !Array.isArray(packed.audienceRows)
        || !Array.isArray(packed.textDictionary)) throw new Error('Invalid packed actor evidence');
    const texts = new Map(packed.textDictionary);
    const audience = new Map(packed.audienceRows.map(([id, time, value]) => {
        const text = typeof value === 'string' ? value : texts.get(value?.ref);
        if (typeof text !== 'string' || !Number.isFinite(time)) throw new Error('Invalid packed actor audience row');
        return [id, { id, time, text }];
    }));
    return packed.clips.map(({ audienceIds, ...clip }) => ({ ...clip, audience: audienceIds.map(id => {
        const row = audience.get(id);
        if (!row) throw new Error(`Missing packed actor audience ID: ${id}`);
        return { ...row };
    }) }));
}

module.exports = { packActorEvidence, unpackActorEvidence };
