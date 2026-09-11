'use strict';

const ai = require('./ai_text_generator');
const live = require('./live_generation_context');
const summary = require('./live_content_summary');
const configLoader = require('./config-loader');
const policy = require('./reply_summary_policy.json');
const full = require('./full_live_context');

const PROMPT_VERSION = 5;
const evidenceTargets = new Set(['reply', 'game', 'song']);
const actorKinds = new Set(['host', 'team', 'audience', 'uncertain', 'performance']);
const normalize = value => String(value || '').normalize('NFKC').replace(/[\p{P}\p{S}\s]/gu, '').toLowerCase();
const chars = value => Array.from(value).length;

function speakerLabel(text) {
    return String(text || '').match(/^\[([^\]\n]+)\]/u)?.[1].replace(/\s+\d*\.?\d+$/u, '').trim() || null;
}

function evidenceContext(segments, danmaku, roomId, config = configLoader.getConfig(), evidence = null, context = null) {
    const room = config.ai?.roomSettings?.[String(roomId)] || {};
    const streamer = Object.values(config.ai?.streamerRegistry || {}).find(s =>
        (s.roomIds || []).some(id => String(id) === String(roomId)));
    const hostLabels = new Set([room.anchorName, ...(room.anchorNicknames || []), streamer?.displayName,
        ...(streamer?.speakerLabels || [])].filter(Boolean).map(normalize));
    const labels = new Set((evidence?.speech || segments).map(s => s.speaker || speakerLabel(s.text)).filter(Boolean));
    const audience = full.aggregateDanmakuForFullContext(danmaku, 30);
    const byId = evidence ? new Map([...evidence.speech,...evidence.audience].map(row => [row.id,row])) : new Map([
        ...segments.map((s, index) => [`T${index + 1}`, { id: `T${index + 1}`, source: 'speech', ...s }]),
        ...audience.map((d, index) => [`D${index + 1}`, { id: `D${index + 1}`, source: 'audience', text: d.text,
            start: d.firstTime, end: d.lastTime, count: d.count }])
    ]);
    const replyDynamic = live.getReplyDynamicEvidence(context);
    if (replyDynamic) byId.set(replyDynamic.id, replyDynamic);
    return { segments, danmaku, hostLabels, multipleSpeakers: labels.size > 1,
        byId, duration: [...segments.map(s => s.end), ...danmaku.map(d => d.time)].reduce((max,value)=>Math.max(max,value),0) };
}

function buildCombinedResponseFormat(materialOptions = null) {
    const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
    const array = (items, maxItems, minItems = 0) => ({ type: 'array', items, minItems, maxItems });
    const string = { type: 'string' };
    const sourceIds = array({ type: 'string', pattern: '^(?:[TD][0-9]+|P1)$' }, 6, 1);
    const properties = {
        reply: { type: 'string', description: 'Final natural reply within the configured character limit.' },
        content: object({
            overview: { type: 'string', description: 'A complete Chinese overview, at most 80 characters.' },
            activityTypes: array({ type: 'string', enum: [...summary.ACTIVITY_TYPES] }, 7),
            songs: array(string, 40), games: array(string, 12), topics: array(string, 10)
        }),
        evidence: array(object({ target: { type: 'string', enum: [...evidenceTargets] }, value: string,
            sourceIds, actor: { type: 'string', enum: [...actorKinds] } }), 24, 2)
    };
    if (materialOptions) properties.moments = array(object({
        sourceIds: array({ type: 'string', pattern: '^[TD][0-9]+$' }, 6, 1), interest: string
    }), materialOptions.maxMoments, 4);
    return { type: 'json_schema', name: materialOptions ? 'live_reply_summary_material' : 'live_reply_summary',
        strict: true, schema: object(properties) };
}

function buildCombinedPrompt({ fullPrefix, highlight, roomId, context, source }) {
    if (!fullPrefix.startsWith(live.SHARED_PROMPT_CACHE_START) || !fullPrefix.endsWith(live.SHARED_PROMPT_CACHE_END)) {
        throw new Error('Combined generation requires a complete shared source prefix');
    }
    const replyRules = ai.buildPrompt(highlight, roomId, null, context, { sharedSourcePrefix: fullPrefix }).slice(fullPrefix.length);
    const overviewRules = summary.buildLiveContentSummaryPrompt(fullPrefix).slice(fullPrefix.length);
    return `${fullPrefix}\n\nCombined reply and overview task v${PROMPT_VERSION}.
Read this complete source once to produce both outputs. Do not generate a comic script in this request.
The outer JSON format below overrides standalone-text formatting in the two task sections. Their content/style rules still apply.
GROUNDING RULES:\n${policy.join('\n')}
The source contains multiple speaker labels: ${Boolean(source?.multipleSpeakers)}.
Only these source speaker labels identify the host: ${JSON.stringify([...(source?.hostLabels || [])])}.
For multi-speaker source quotes without a recognized host label, actor must be team or uncertain, and the corresponding reply phrase must stay team-level. Do not name who led, healed, commanded or performed the action.
Return exactly one JSON object with keys reply, content, evidence. Prose is Chinese.
reply: the final natural comment, within the configured character limit, without a title or Markdown.
content: a JSON OBJECT with exactly overview, activityTypes, songs, games, topics. Never replace content with the overview string or move its fields to the outer object. overview is a complete sentence of at most 80 Chinese characters; the other four fields are arrays. Do not call it exhaustive. Include actual later activity changes, but list only confidently supported performed songs and played games; empty lists are allowed when supported.
Required nesting: {"reply":"final comment","content":{"overview":"complete overview","activityTypes":[],"songs":[],"games":[],"topics":[]},"evidence":[...]}.
evidence: 2-24 records covering every concrete factual assertion in the reply and every listed song/game. Each record has exactly these required fields:
{"target":"reply|game|song","value":"exact reply phrase, or exact listed song/game name","sourceIds":["T123","D456"],"actor":"host|team|audience|uncertain|performance"}.
T-IDs identify original subtitle segments and D-IDs identify merged audience messages, never speaker identities. Return 1-6 existing source IDs per record; the program will retrieve exact text. Do not retype, repair or paraphrase evidence quotes. value for reply must occur verbatim in reply. Actor host requires supporting named-host T-IDs, not only D-IDs or guest/unknown T-IDs. For canonical song/game names also include a nearby D-ID or T-ID that confirms the spelling, and a T-ID proving actual performance/play instead of a mere mention. If uncertain, omit the name.
${source?.byId?.has('P1') ? 'P1 is the already-published post in the reply section, not speech or audience. Cite P1 only for target reply when directly responding to what the host posted (actor host is allowed for that post). It cannot prove a live event, played game, performed song or any overview field. Keep at least one T/D-grounded live detail in the reply; P1 does not replace the live source.' : ''}
Do not invent evidence. If an attractive detail cannot be supported, choose a different detail or remove that claim before returning.
REPLY CONTENT RULES:\n${replyRules}\nOVERVIEW CONTENT RULES:\n${overviewRules}`;
}

function validateCombinedResult(text, source, roomId, wordLimit = configLoader.getWordLimit(roomId)) {
    const raw = summary.parseJsonObject(text);
    if (typeof raw.reply !== 'string' || chars(raw.reply.trim()) > wordLimit) throw new Error('Invalid combined reply length');
    const inspection = ai.inspectGeneratedReply(raw.reply, wordLimit, roomId);
    if (!inspection.ok) throw new Error(inspection.reason);
    const content = raw.content;
    if (!content || typeof content !== 'object' || Array.isArray(content)) throw new Error('Invalid content: expected an object with overview, activityTypes, songs, games, topics');
    if (typeof content.overview !== 'string' || !content.overview.trim()) throw new Error('Invalid content.overview: expected a non-empty string');
    if (chars(content.overview) > 80) throw new Error('Invalid content.overview: exceeds 80 characters; truncation is forbidden');
    const limits = { activityTypes: [7,24], songs: [40,80], games: [12,80], topics: [10,32] };
    for (const [field,[maxItems,maxChars]] of Object.entries(limits)) {
        if (!Array.isArray(content[field]) || content[field].length > maxItems || content[field].some(v =>
            typeof v !== 'string' || !v.trim() || chars(v) > maxChars)) throw new Error(`Invalid content.${field}`);
    }
    const normalized = summary.normalizeLiveContent(content);
    if (!Array.isArray(raw.evidence) || raw.evidence.length < 2 || raw.evidence.length > 24) throw new Error('Missing or excessive evidence');
    const linked = raw.evidence.map(record => {
        if (!record || !evidenceTargets.has(record.target) || !actorKinds.has(record.actor)
            || typeof record.value !== 'string' || !record.value.trim() || !Array.isArray(record.sourceIds)
            || record.sourceIds.length < 1 || record.sourceIds.length > 6
            || record.sourceIds.some(id => typeof id !== 'string' || !source.byId.has(id))) {
            throw new Error('Invalid evidence record');
        }
        const rows = [...new Set(record.sourceIds)].map(id => source.byId.get(id));
        const speech = rows.filter(r => r.source === 'speech');
        const hasReplyDynamic = rows.some(r => r.source === 'reply_dynamic');
        if (hasReplyDynamic && record.target !== 'reply') throw new Error('Post evidence is only valid for a reply');
        const namedOther = speech.some(s => {
            const label = s.speaker || speakerLabel(s.text);
            return label && !/^(?:UNKNOWN|SPEAKER_\d+)$/iu.test(label) && !source.hostLabels.has(normalize(label));
        });
        if (record.actor === 'host' && ((!speech.length && !hasReplyDynamic) || namedOther)) {
            throw new Error('Host attribution lacks a recognized source speaker');
        }
        const hostAttributionUnverified = record.actor === 'host' && source.multipleSpeakers
            && !speech.every(s => source.hostLabels.has(normalize(s.speaker || speakerLabel(s.text))));
        if (record.target === 'reply' && !inspection.cleaned.includes(record.value)) throw new Error('Evidence does not refer to the reply');
        let corroboration = [];
        if (record.target !== 'reply') {
            const field = record.target === 'game' ? 'games' : 'songs';
            if (!normalized[field].includes(record.value)) throw new Error('Evidence does not refer to a listed activity');
            corroboration = [...source.byId.values()].filter(r => speech.some(s => r.end >= s.start - 60 && r.start <= s.end + 60)
                && normalize(r.text).includes(normalize(record.value))).slice(0, 3);
            if (!speech.length || (!normalize(rows.map(r => r.text).join(' ')).includes(normalize(record.value)) && !corroboration.length)) {
                throw new Error('Activity name lacks nearby source corroboration');
            }
        }
        return { ...record, sources: rows, corroboration, hostAttributionUnverified, linked: true };
    });
    if (!linked.some(r => r.target === 'reply' && r.sources.some(row => row.source !== 'reply_dynamic'))) {
        throw new Error('Reply has no linked live evidence');
    }
    for (const [field,target] of [['games','game'],['songs','song']]) {
        for (const value of normalized[field]) if (!linked.some(r => r.target === target && r.value === value)) {
            throw new Error(`Listed ${target} has no evidence`);
        }
    }
    return { reply: inspection.cleaned, content: normalized, evidence: linked,
        validation: { status: 'source-linked', semanticTruthProven: false, promptVersion: PROMPT_VERSION } };
}

module.exports = { PROMPT_VERSION, policy, evidenceContext, buildCombinedPrompt, buildCombinedResponseFormat, validateCombinedResult };
