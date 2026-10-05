'use strict';
const own = require('./own_stream_clipper');
const config = require('./config-loader').getConfig();
const runtime = require('./workflow-runtime');
const publication = require('./clipping/own_automatic_publication');
const { reviewContext } = require('./clipping/own_publication_context');
runtime.loadWorkflow('clipping/ownPublicationRecheck').recheckOwnPublication(process.argv.slice(2), {
    lock: require('./render_topic_candidate').acquireCandidateLock,
    config: room => own.getOwnStreamClipsConfig(config, room),
    repair: (artifact, required, subtitles) => (subtitles ? publication.repairSubtitles : publication.repairPublicCopy)(artifact, reviewContext(artifact, config), required),
    reviewFinal: async (artifact, required) => {
        const current = { ...artifact, attributionRequired: Boolean(artifact.attributionRequired || required.attributionRequired),
            qaRequired: Boolean(artifact.qaRequired || required.qaRequired) };
        return (await publication.inspectFinals([current], reviewContext(current, config)))[0];
    }
}).then(result => console.log('PUBLICATION_RECHECK_RESULT: ' + JSON.stringify(result)))
    .catch(error => { console.error(error.message); process.exitCode = 2; });
