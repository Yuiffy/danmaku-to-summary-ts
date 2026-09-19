'use strict';
const { nameMatcher } = require('./person_evidence');

// Audience comments can support an audience reaction, never a speaker identity.
// Keep their D IDs out of speech cueIds; the global quote/number check still runs.
function validateAudienceClaim(claim, review, packet) {
    const issues = [];
    const ids = claim.evidenceDanmakuIds;
    if (!Array.isArray(ids) || !ids.length || ids.some(id => !packet.danmakuIds.has(id)
        || !review.evidenceDanmakuIds?.includes(id))) issues.push('invalid_audience_claim_citation');
    if (!Array.isArray(claim.speakerCueIds) || claim.speakerCueIds.length
        || claim.narrator !== null || claim.actor !== null
        || !['explicit_text', 'unresolved'].includes(claim.identityBasis)) issues.push('audience_claim_as_speech');
    for (const field of claim.fields) {
        if (!/(?:弹幕|观众|评论|网友|\b(?:chat|viewer|audience|comment))/iu.test(review.copy[field])) {
            issues.push(`audience_claim_not_labelled:${field}`);
        }
    }
    if (claim.target !== null) {
        const person = packet.context?.people?.find(person => [person.label, person.preferredName, ...person.names].includes(claim.target));
        const text = packet.data.audience.filter(row => Array.isArray(ids) && ids.includes(row.id)).map(row => row.text).join('\n');
        if (typeof claim.target !== 'string' || !claim.target.trim()
            || !nameMatcher(person?.names || [claim.target])(text)) issues.push('unproven_target');
    }
    return issues;
}

module.exports = { validateAudienceClaim };
