'use strict';

// These are citation affordances, not inferred speaker labels. Only unchanged,
// locally accepted row evidence is offered to the editor as a voice citation.
function voiceCitationGuide(packet) {
    const speakers = new Map();
    for (const id of packet.cueIds) {
        const items = packet.evidence.byId.get(id)?.items || [];
        const label = items[0]?.speakerEvidence?.label;
        if (!label || !items.length || !items.every(item => item.speakerEvidence?.status === 'row_supported'
            && item.speakerEvidence.label === label)) continue;
        const person = packet.context?.people?.find(person => [person.label, ...(person.names || [])].includes(label));
        if (!person) continue;
        if (!speakers.has(person.id)) speakers.set(person.id, { speaker: person.label,
            copyName: person.preferredName || person.label, cueIds: [] });
        speakers.get(person.id).cueIds.push(id);
    }
    return [...speakers.values()];
}

function repairFeedback(packet, review, issues) {
    const array = value => Array.isArray(value) ? value : [];
    return { clipId: packet.id, previous: review, issues,
        allowedActionCueIds: [...packet.cueIds], voiceCitations: voiceCitationGuide(packet),
        claims: array(review?.claims).map((claim, index) => ({ claim: index + 1, action: claim?.action,
            invalidActionCueIds: array(claim?.cueIds).filter(id => !packet.cueIds.has(id)),
            invalidSpeakerCueIds: array(claim?.speakerCueIds).filter(id => !packet.cueIds.has(id)
                || (claim.identityBasis === 'voice' && !array(claim.cueIds).includes(id))) })),
        newDialogueEvidence: Boolean(packet.dialogueEvidence) };
}

// The model writes the question; the program owns its location and excerpt.
// Invalid or invented locations are never presented as a checked listening cue.
function humanChecks(packet, review) {
    const plain = value => value.replace(/\bG\d+(?:\s*[-–—~]\s*G?\d+)?/gu, '这段原话')
        .replace(/\bD\d+/gu, '这条弹幕').replace(/\s+/g, ' ').slice(0, 100);
    if (!Array.isArray(review?.humanChecks)) return [];
    return review.humanChecks.slice(0, 6).flatMap(check => {
        if (typeof check?.question !== 'string' || !check.question.trim()
            || !Array.isArray(check.cueIds) || !check.cueIds.length
            || check.cueIds.some(id => !packet.cueIds.has(id))) return [];
        const cues = [...new Set(check.cueIds)].map(id => packet.evidence.byId.get(id));
        return [{ question: plain(check.question),
            suggestion: typeof check.suggestion === 'string' ? plain(check.suggestion) : '',
            cueIds: cues.map(cue => cue.id),
            evidence: cues.map(({ id, start, end, text }) => ({ id, start, end, text })) }];
    });
}

module.exports = { voiceCitationGuide, repairFeedback, humanChecks };
