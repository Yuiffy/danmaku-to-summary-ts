'use strict';

// Constrain IDs during generation as well as after it. Grouped G IDs are sparse:
// a model must never interpolate the missing numbers between two real cues.
function actorReviewResponseFormat(packets) {
    const string = { type: 'string' }, person = { type: ['string', 'null'] };
    const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
    const list = (items, extra = {}) => ({ type: 'array', items, ...extra });
    const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
    const ids = values => values.length ? list({ type: 'string', enum: values }) : list(string, { maxItems: 0 });
    const reviews = packets.map(packet => {
        const cues = ids([...packet.cueIds]);
        const cited = { ...cues, minItems: packet.cueIds.size ? 1 : 0 };
        const role = nullable(object({ entityId: person, mention: string, cueIds: cues,
            contextIds: ids((packet.entityContext?.rows || []).map(row => row.id)),
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] }, reason: string }));
        return object({ clipId: { type: 'string', enum: [packet.id] },
            decision: { type: 'string', enum: ['accept', 'repair', 'needs_review'] },
            copy: nullable(object({ title: string, coverText: string, description: string })),
            claims: list(object({ fields: list({ type: 'string', enum: ['title', 'coverText', 'description'] }, { minItems: 1 }),
                action: string, narrator: person, actor: person, target: person,
                sourceKind: { type: 'string', enum: ['live_speech', 'recount', 'playback', 'audience', 'uncertain'] },
                identityBasis: { type: 'string', enum: ['voice', 'explicit_text', 'unresolved', ...(packet.dialogueEvidence ? ['dialogue'] : [])] },
                speakerCueIds: cues, cueIds: cues, evidenceDanmakuIds: ids([...packet.danmakuIds]),
                roleEvidence: packet.entityContext ? nullable(object({ actor: role, target: role })) : { type: 'null' } }), { maxItems: 20 }),
            evidenceDanmakuIds: ids([...packet.danmakuIds]), reason: string,
            humanChecks: list(object({ question: string, suggestion: string, cueIds: cited }), { maxItems: 3 }) });
    });
    return { type: 'json_schema', name: 'actor_reviews', strict: true,
        schema: object({ reviews: list({ anyOf: reviews }, { minItems: packets.length, maxItems: packets.length }) }) };
}

module.exports = { actorReviewResponseFormat };
