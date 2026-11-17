'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function fileDigest(file) {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'r');
    try {
        const buffer = Buffer.alloc(1024 * 1024);
        let count;
        while ((count = fs.readSync(fd, buffer)) > 0) hash.update(buffer.subarray(0, count));
    } finally { fs.closeSync(fd); }
    return hash.digest('hex');
}

function sourceSnapshot(metadata) {
    const source = metadata.source;
    const stat = fs.statSync(source.mediaPath, { bigint: true });
    return { mediaPath: path.resolve(source.mediaPath), mediaBytes: String(stat.size), mediaMtimeNs: String(stat.mtimeNs),
        srtPath: path.resolve(source.srtPath), srtSha256: fileDigest(source.srtPath),
        xmlPath: source.xmlPath ? path.resolve(source.xmlPath) : null,
        xmlSha256: source.xmlPath ? fileDigest(source.xmlPath) : null };
}

function assertRenderedRevision(metadata) {
    const draft = metadata.renderedSubtitles;
    if (draft && (metadata.rebuildRequired || draft.renderedSha256 !== draft.sha256
        || draft.renderedRevision !== draft.revision || fileDigest(draft.path) !== draft.sha256
        || fileDigest(metadata.output.srtPath) !== draft.sha256)) {
        throw new Error('Current subtitle revision must be rendered before approving the video');
    }
}

module.exports = { fileDigest, sourceSnapshot, assertRenderedRevision };
