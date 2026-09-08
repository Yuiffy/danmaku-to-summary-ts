'use strict';
const fs = require('fs');
const crypto = require('crypto');

async function fileDigest(file) {
    if (typeof file !== 'string' || !file) throw new Error('Missing reviewed artifact path');
    const before = await fs.promises.stat(file);
    if (!before.isFile()) throw new Error('Reviewed artifact is not a regular file');
    const digest = crypto.createHash('sha256');
    for await (const block of fs.createReadStream(file)) digest.update(block);
    const after = await fs.promises.stat(file);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('Artifact changed while binding review');
    return digest.digest('hex');
}

async function bindActorArtifacts(metadata) {
    if (!metadata.attributionRequired || metadata.attributionReview?.status !== 'passed' || !metadata.uploadReady) return metadata;
    try {
        const review = metadata.attributionReview;
        const { start, end } = metadata.window || {};
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start !== review.start || end !== review.end) {
            throw new Error('Source window differs from actor review');
        }
        const video = await fileDigest(metadata.output?.mediaPath);
        const subtitles = await fileDigest(metadata.output?.srtPath);
        return { ...metadata, attributionReview: { ...review, artifactWindow: { start, end },
            artifactDigests: { video, subtitles } } };
    } catch (error) {
        return { ...metadata, uploadReady: false, publicCopyPending: true,
            attributionReview: { ...metadata.attributionReview, status: 'needs_review',
                invalidated: `artifact_binding_failed:${error.message}` } };
    }
}

module.exports = { bindActorArtifacts };
