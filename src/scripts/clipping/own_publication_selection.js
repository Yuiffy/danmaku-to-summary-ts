'use strict';
const fs = require('fs');
const path = require('path');
const publicationPolicy = require('./publication_policy');

// Extracted from the own-stream CLI: source filtering, publication report and IO wiring.
async function selectOwnPublication(clips, { options, config, rootConfig, info, parsed, outputRoot, reviewMetadata, aiDiagnostics }) {
    clips = require('../../core/media/RecordingCoverage.ts').filterCampaignCoverage(clips, options.mediaPath);
    clips = await require('./editorial_styles').curateSource(clips, 'own', { rootConfig, config, info, options, parsed, outputRoot });
    const publication = publicationPolicy.selectPublication(clips, {
        ...config.publicationPolicy, ...(options.publicationMode ? { mode: options.publicationMode } : {})
    }, info.roomId);
    if (publication.report.policy.mode !== 'all' || publication.report.deferredCount) {
        const report = publication.report;
        const label = options.planPath ? path.basename(options.planPath, path.extname(options.planPath)) + '_' : '';
        report.reviewPath = path.join(outputRoot, `${label}PUBLICATION_REVIEW.md`);
        report.bundles = await require('./publication_bundles').proposeBundles(report, parsed, info, config, rootConfig, aiDiagnostics);
        reviewMetadata.publication = report;
        fs.writeFileSync(report.reviewPath, publicationPolicy.publicationMarkdown(report), 'utf8');
    }
    return publication.clips;
}
module.exports = { selectOwnPublication };
