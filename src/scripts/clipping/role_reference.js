'use strict';
const { nameMatcher } = require('./person_evidence');
const { normalizeName, matchesNameMention, entityDigest, rawCueText } = require('./entity_context');

function validateRoleReference(claim, role, packet) {
    const context = packet.entityContext;
    const ref = claim.roleEvidence?.[role];
    const fail = message => [`${message}:${role}`];
    if (!['actor', 'target'].includes(role) || typeof claim[role] !== 'string' || !claim[role].trim()) return fail('invalid_role_entity');
    if (!context || context.sourceSha256 !== packet.sourceSha256 || context.start !== packet.clip.start
        || context.end !== packet.clip.end || context.digest !== entityDigest(context)) return fail('entity_context_changed');
    if (!ref) return fail('missing_role_reference');
    if (ref.confidence !== 'high' || typeof ref.reason !== 'string' || !ref.reason.trim()) return fail('uncertain_role_reference');
    if (typeof ref.mention !== 'string' || ref.mention.trim().length < 2 || ref.mention.length > 60
        || /^(?:我们|你们|他们|她们|对方|自己|someone|they|them|she|her|he|him|you|we)$/iu.test(ref.mention.trim())) return fail('invalid_role_mention');
    if (!Array.isArray(ref.cueIds) || !ref.cueIds.length || ref.cueIds.length > 8 || ref.cueIds.some(id => !packet.cueIds.has(id))) return fail('invalid_role_citation');
    if (!Array.isArray(ref.contextIds) || ref.contextIds.length > 8
        || ref.contextIds.some(id => !context.rows.some(row => row.id === id))) return fail('invalid_name_context_citation');
    const anchors = ref.cueIds.map(id => packet.evidence.byId.get(id));
    const mentions = anchors.filter(cue => nameMatcher([ref.mention])(rawCueText(cue)));
    if (!mentions.length) return fail('role_mention_not_in_speech');
    const actionCues = (claim.cueIds || []).map(id => packet.evidence.byId.get(id)).filter(Boolean);
    if (!actionCues.some(cue => mentions.some(anchor => Math.max(0, cue.start - anchor.end, anchor.start - cue.end)
        <= context.maxReferenceGapSeconds))) return fail('role_reference_too_distant');
    const rows = ref.contextIds.map(id => context.rows.find(row => row.id === id));
    const speech = [...anchors.map(rawCueText), ...rows.filter(row => row.kind === 'speech').map(row => row.text)];
    const canonicalFor = person => [person.name, person.copyName, ...person.names].map(normalizeName).includes(normalizeName(claim[role]));
    const person = context.people.find(person => person.id === ref.entityId);
    if (ref.entityId !== null && (!person || !canonicalFor(person))) return fail('role_entity_mismatch');
    if (ref.entityId === null && context.people.some(canonicalFor)) return fail('role_entity_id_required');
    const canonicalNames = person ? person.names : [String(claim[role] || '')];
    const canonical = nameMatcher(canonicalNames);
    const formalMention = canonicalNames.some(name => matchesNameMention(ref.mention, name));
    const bridge = speech.some(text => canonical(text) && nameMatcher([ref.mention])(text));
    const hint = person?.hints.find(hint => matchesNameMention(ref.mention, hint.name));
    if (!formalMention && !hint && !bridge) return fail('unproven_role_alias');
    const competitors = context.people.filter(item => [...item.names, ...item.hints.map(hint => hint.name)]
        .some(name => matchesNameMention(ref.mention, name) || matchesNameMention(name, ref.mention)));
    if (competitors.length > 1) {
        const uniqueNames = canonicalNames.filter(name => !competitors.some(other => other.id !== person?.id
            && [...other.names, ...other.hints.map(hint => hint.name)].some(otherName =>
                matchesNameMention(name, otherName) || matchesNameMention(otherName, name))));
        if (!uniqueNames.length || !speech.some(text => nameMatcher(uniqueNames)(text)
            && nameMatcher([ref.mention])(text))) return fail('ambiguous_role_alias');
    }
    const allSpeech = [...packet.cueIds].map(id => rawCueText(packet.evidence.byId.get(id))).join('\n');
    const contradictoryText = [allSpeech, ...context.rows.filter(row => row.kind === 'speech').map(row => row.text)].join('\n');
    if (!formalMention && [ref.mention, ...(hint ? [hint.name] : [])].some(mention =>
        contradictsAlias(mention, canonicalNames, contradictoryText))) return fail('contradicted_role_alias');
    if (!formalMention && !bridge) {
        const audienceBridge = hint?.kind === 'nickname' && rows.some(row => row.kind === 'audience'
            && canonical(row.text) && nameMatcher([hint.name])(row.text));
        const repeatedNickname = hint?.kind === 'nickname' && new Set(mentions.map(cue => cue.id)).size >= 2;
        const independentName = speech.some(canonical);
        if (!audienceBridge && !repeatedNickname && !independentName) return fail('uncorroborated_role_alias');
    }
    return [];
}

function contradictsAlias(mention, names, text) {
    const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const alias = escape(mention), canonical = names.map(escape).join('|');
    const middle = '[^。！？.!?\\n]{0,16}(?:不是|并非|不指|not|isn\u0027t)[^。！？.!?\\n]{0,8}';
    return new RegExp(`(?:${alias})${middle}(?:${canonical})|(?:${canonical})${middle}(?:${alias})`, 'iu').test(text);
}

function roleReferencePromptLines() {
    return [
        'entityContext只用于本片人名/昵称/指代消歧，不证明在场或出声。N-ID含片外语音/弹幕，绝不支持片内动作或引文；cueIds只能用inRangeCueIds。',
        'people.hints是自动检索的候选称呼，不是全局等号；同音、名字同现、弹幕喊名均不能单独认人。明确否定、重名、话题切换和其他先行词优先。',
        '为每个不等同于已核验讲述者的具名actor/target填写roleEvidence，分别核查提问者、回答者及被问者；未确定就null，不借房主补全。',
        'roleEvidence的actor/target各为{"entityId":"人物资料ID或null","mention":"原话确有的姓名或称呼，不能填他/她","cueIds":["本片称呼锚点G-ID"],"contextIds":["只用于称呼对应的N-ID"],"confidence":"high","reason":"称呼与当前动作的指代链，如何排除其他人"}。',
        '称呼锚点与claim.cueIds的动作句可以不同；要引用完整问答的先行词，不能只因名字在同段出现就归给它。无需把同音ASR字替换成真名后造证据。',
        '资料ID的人名使用name或copyName。目录外人物可用entityId=null及原话中的真实称呼，不需要预先登记，但不能编造实名。',
        '区分角色名称与目录ID：原话已明确姓名或角色称呼时，actor/target仍填该姓名或称呼（如司机）；只有entityId填null。roleEvidence不为空而对应actor/target为空是矛盾，必须修正或needs_review。',
        '先核查自动候选：若原话称呼、配置中的昵称对应及姓名上下文相互印证，应使用已知entityId和公开名；不要因为本人未出声而把已可核验的名字降成匿名。仍不能排除重名则needs_review或明确保留未知。',
        '昵称需要片内明确称呼加独立名字证据（另一条称呼原话、全名原话或有配置对应且同句解释昵称/全名的评论）；ASR误听候选必须另有原话名字印证。',
        '仅被提到的人也可成为过去故事的动作执行者/对象，不需要现场声纹；不得因此说她当前连麦、出声或在场。'
    ];
}

module.exports = { validateRoleReference, roleReferencePromptLines };
