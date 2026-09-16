'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const discoveryPath = mediaPath => path.join(path.dirname(mediaPath), `${path.parse(mediaPath).name.replace(/\.speaker$/u, '')}.participant_discovery.json`);
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function sourceBinding(mediaPath) {
    const stat = fs.statSync(mediaPath);
    return { sourceMediaPath: path.resolve(mediaPath), size: stat.size, mtimeMs: stat.mtimeMs };
}

function loadParticipantDiscovery(srtOrMediaPath, roomId, config = {}) {
    if (config.asr?.participantDiscovery?.enabled === false) return null;
    try {
        const data = JSON.parse(fs.readFileSync(discoveryPath(srtOrMediaPath), 'utf8'));
        if (data.version !== 1 || data.source !== 'session_participant_discovery'
            || String(data.roomId) !== String(roomId) || !data.binding?.sourceMediaPath
            || data.registrySha256 !== hash(config.ai?.streamerRegistry || {})
            || hash(sourceBinding(data.binding.sourceMediaPath)) !== hash(data.binding)) return null;
        // The same-basename sidecar must refer to this recording, not a copied session.
        if (path.resolve(discoveryPath(data.binding.sourceMediaPath)) !== path.resolve(discoveryPath(srtOrMediaPath))) return null;
        return data;
    } catch { return null; }
}

module.exports = { discoveryPath, sourceBinding, hash, loadParticipantDiscovery };
