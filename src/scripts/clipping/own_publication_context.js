'use strict';
const own = require('../own_stream_clipper');
const runtime = require('../workflow-runtime');

// Shared extraction of the existing maintenance command's process adapters.
function reviewContext(artifact, config) {
    const settings = own.getOwnStreamClipsConfig(config, artifact.roomId);
    return { runtime: runtime.loadWorkflow('clipping/publicationRuntime'),
        automatic: settings.automaticPublication, config: settings, rootConfig: config,
        info: { roomId: artifact.roomId, streamerName: artifact.streamerName, streamTitle: artifact.streamTitle, recordedAt: artifact.recordedAt },
        streamerName: artifact.streamerName, options: {}, mediaConfig: own.buildCutClipMediaConfig(settings, {}), persist: false,
        evidence: require('./subtitle_evidence').buildSubtitleEvidence, audience: own.parseDanmakuXml,
        copyHelpers: { buildClipDescription: own.buildClipDescription, buildCoverTitle: own.buildCoverTitle } };
}
module.exports = { reviewContext };
