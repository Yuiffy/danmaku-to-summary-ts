'use strict';

const { getTopicClipAiModel } = require('./topic_config');
const { requestSelectionText } = require('./selection_request');
const { buildFallbackAiClipSelection } = require('./topic_selection');
const { formatTopicEvidence, buildTopicEventPrompt, normalizeTopicEvents, buildTopicCopyPrompt, normalizeTopicCopy } = require('./topic_editorial');

function validWith(normalize) {
    return result => { try { normalize(result.text); return true; } catch { return false; } };
}

async function planTopicEventGroup(group, evidence, config, rootConfig, streamerName, info, diagnostics) {
    try {
        // Never sample or truncate away a story's middle or payoff to fit a request.
        if (formatTopicEvidence(group.cues).length > config.editorial.maxEvidenceChars) {
            throw new Error('Editorial evidence exceeds the request budget; manual boundary review required');
        }
        const normalize = text => normalizeTopicEvents(text, group, evidence, config);
        const result = await requestSelectionText(
            buildTopicEventPrompt(group, config, streamerName, info),
            { wordLimit: 1600, primaryModel: getTopicClipAiModel(rootConfig) },
            config, rootConfig, info, 'topic_events_v1', diagnostics, validWith(normalize)
        );
        return normalize(result.text).map(clip => ({ ...clip,
            aiModel: result.meta?.model || getTopicClipAiModel(rootConfig) }));
    } catch (error) {
        diagnostics.failures.push({ stage: 'planning', severity: 'warning',
            window: { start: group.start, end: group.end }, error: error.message });
        // Preserve original recall windows for review, never label a mechanical union
        // as an editorial merge or reuse candidate copy for a different interval.
        return group.bursts.flatMap(burst => buildFallbackAiClipSelection(burst).map(clip => ({ ...clip,
                editorial: { status: 'fallback', reason: error.message, sourceKind: 'uncertain',
                    sourceBurstIndices: [burst.index] } })))
            .map((clip, index) => ({ ...clip, sliceIndex: index + 1 }));
    }
}

async function generateTopicEventCopy(clip, evidence, config, rootConfig, streamerName, info, diagnostics) {
    const { prompt, cues } = buildTopicCopyPrompt(clip, evidence, streamerName, require('../ai_text_generator'));
    if (!cues.length || formatTopicEvidence(cues).length > config.editorial.maxEvidenceChars) {
        throw new Error('Final clip has no complete evidence or exceeds the copy evidence budget');
    }
    const normalize = text => normalizeTopicCopy(text, clip, evidence, cues);
    const result = await requestSelectionText(prompt,
        { wordLimit: 600, primaryModel: getTopicClipAiModel(rootConfig) },
        config, rootConfig, info, 'topic_final_copy_v1', diagnostics, validWith(normalize));
    return { ...normalize(result.text), model: result.meta?.model || getTopicClipAiModel(rootConfig) };
}

module.exports = { planTopicEventGroup, generateTopicEventCopy };
