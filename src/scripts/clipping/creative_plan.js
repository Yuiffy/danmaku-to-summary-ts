'use strict';

// A small closed vocabulary: model output never becomes a path, filter or ASS command.
const STICKERS = Object.freeze({ question: '?', surprise: '!', sparkle: '✦' });
const isSticker = id => Object.hasOwn(STICKERS, id);
// Chat is quoted on screen as its own layer — a Bilibili-style flythrough or a speech
// bubble. Enlarging the chat column in place never isolates the one line that matters,
// so it is opt-in only (settings.chatInset) and off by default.
const DANMAKU_STYLES = Object.freeze(['scroll', 'bubble']);
const chatKey = text => String(text).replace(/\s+/g, '').replace(/[，。！？、,.!?~～…；：""''（）()]/g, '');

// Fallback picker for a node the model left without a quote: still a real chat line,
// prefer the ones that read as a reaction, skip sticker codes and duplicates.
function pickDanmaku(pool, used = new Set()) {
    const clean = [...new Set((pool || []).map(text => String(text ?? '').trim()))]
        .filter(text => text.length >= 3 && text.length <= 22 && !/^\[.*\]$/.test(text) && !used.has(text));
    if (!clean.length) return null;
    const score = text => (/走反|反了|哈哈|绷不住|笑死|可爱|铃铛|主包|笨蛋|人类吗|新游戏|羡慕|开过/.test(text) ? 2 : 0)
        + (/[[\]]/.test(text) ? -3 : 0) + (text.length >= 4 && text.length <= 14 ? 1 : 0);
    return clean.sort((a, b) => score(b) - score(a))[0];
}
const SOUNDS = Object.freeze({ pop: { frequency: 420, duration: .12 }, ding: { frequency: 880, duration: .25 } });
const { soundId } = require('./creative_assets');
const FILTERS = Object.freeze({ monochrome: 'hue=s=0', cold: 'colorbalance=rs=-0.10:bs=0.16:bm=0.08',
    warm: 'eq=saturation=1.25:contrast=1.06:brightness=0.015', vignette: 'vignette=angle=PI/4' });
const finite = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const round = value => Math.round(value * 1000) / 1000;

function creativeSettings(raw = {}) {
    const compact = raw.style === 'compact';
    const density = raw.editorialDensity || 'dense', cap = density === 'light' ? 6 : density === 'moderate' ? 12 : 24;
    return { style: compact ? 'compact' : 'accent', editorialDensity: density, maxMoments: Math.max(1, Math.min(compact ? cap : 8, Math.floor(Number(raw.maxMoments) || (compact ? 24 : 6)))),
        maxEffectSeconds: compact ? 12 : 6, maxCoverage: compact ? density === 'light' ? .3 : density === 'moderate' ? .6 : .9 : .30,
        maxTotalEffectSeconds: compact ? 150 : 40, minGapSeconds: compact ? density === 'light' ? 2 : density === 'moderate' ? 1 : .15 : 4,
        maxZoom: Math.max(1.15, Math.min(compact ? 5 : 2.6, Number(raw.maxZoom) || (compact ? 5 : 2.4))), variety: raw.variety === true,
        soundEffects: raw.soundEffects === true, filters: raw.filters === true, avatarMode: raw.avatarMode || 'auto',
        // Enlarging the chat column in place is opt-in: a quoted line reads better as a
        // danmaku flythrough or bubble, and three enlarged lines at once have no focus.
        chatInset: raw.chatInset === true, danmakuRequired: raw.danmakuRequired === true,
        // Some sources already carry a full game/stream mix; adding music on top makes
        // the dialogue compete with two beds, so the operator can switch it off.
        music: raw.music !== false,
        focusPlacement: raw.focusPlacement || 'free', faceInsetDiameter: raw.faceInsetDiameter || null };
}

function speechForCreative(segments, window) {
    return segments.map((row, index) => ({ id: `S${index + 1}`, start: round(Math.max(0, row.start - window.start)),
        end: round(Math.min(window.end - window.start, row.end - window.start)), text: row.text }))
        .filter(row => row.end > row.start);
}

function validateMoments(raw, speech, duration, settings) {
    if (!Array.isArray(raw?.moments) || raw.moments.length > settings.maxMoments) throw new Error('Invalid creative moment count');
    const overlong = raw.moments.flatMap((row, index) => row && Number.isFinite(row.start) && Number.isFinite(row.end)
        && row.end - row.start > settings.maxEffectSeconds + .0005
        ? [`M${index + 1}: ${round(row.end - row.start)}s exceeds ${settings.maxEffectSeconds}s`] : []);
    if (overlong.length) throw new Error(`Creative moments exceed the per-node duration limit: ${overlong.join('; ')}`);
    const moments = raw.moments.map((row, index) => {
        if (!row || !finite(row.start, 0, duration + .0005) || !finite(row.end, 0, duration + .0005)
            || round(row.end - row.start) < .6 || round(row.end - row.start) > settings.maxEffectSeconds
            || typeof row.reason !== 'string' || !row.reason.trim() || row.reason.length > 300
            || !Array.isArray(row.speechIds) || !row.speechIds.length || row.speechIds.length > (settings.style === 'compact' ? 8 : 5)
            || row.speechIds.some(id => !speech.some(cue => cue.id === id && cue.end > row.start - 1 && cue.start < row.end + 1))) {
            throw new Error(`Creative moment has invalid timing or speech evidence: M${index + 1} ${JSON.stringify(row)}; nearby speech IDs: `
                + speech.filter(cue => cue.end > row?.start - 1 && cue.start < row?.end + 1).map(cue => cue.id).join(','));
        }
        return { id: `M${index + 1}`, start: Math.min(duration, round(row.start)), end: Math.min(duration, round(row.end)), reason: row.reason, speechIds: [...new Set(row.speechIds)] };
    }).sort((a, b) => a.start - b.start);
    const spacing = moments.flatMap((row, i) => i && round(row.start - moments[i - 1].end) < settings.minGapSeconds
        ? [`${moments[i - 1].id}->${row.id}: gap ${round(row.start - moments[i - 1].end)}s must be >= ${settings.minGapSeconds}s`] : []);
    const total = round(moments.reduce((n, row) => n + row.end - row.start, 0));
    const maximum = Math.min(settings.maxTotalEffectSeconds, duration * settings.maxCoverage);
    if (total > maximum + .001) spacing.push(`total coverage ${total}s must be <= ${maximum.toFixed(3)}s`);
    if (spacing.length) throw new Error(`Creative effects exceed the spacing/coverage budget: ${spacing.join('; ')}`);
    return moments;
}

/**
 * Deterministic drop-to-budget for moment candidates: the story can retain a long
 * dense tail, and the model then proposes overlapping or over-coverage moments that
 * a single repair round-trip may not fix. Moments are suggestions — enforce the same
 * budgets the validator checks by greedily keeping chronological candidates and
 * dropping the violators, instead of failing the whole visual stage.
 */
function sanitizeMoments(raw, speech, duration, settings) {
    const candidates = (Array.isArray(raw?.moments) ? raw.moments : [])
        .map(row => ({
            start: Math.max(0, Math.min(duration, Number(row?.start))),
            end: Math.max(0, Math.min(duration, Number(row?.end))),
            reason: String(row?.reason || '').trim(), speechIds: Array.isArray(row?.speechIds) ? [...new Set(row.speechIds)] : []
        }))
        .filter(row => {
            const length = row.end - row.start;
            return Number.isFinite(length) && length >= .6 && length <= settings.maxEffectSeconds + .0005
                && row.reason && row.reason.length <= 300 && row.speechIds.length
                && row.speechIds.every(id => speech.some(cue => cue.id === id && cue.end > row.start - 1 && cue.start < row.end + 1));
        })
        .sort((a, b) => a.start - b.start);
    const kept = [];
    let total = 0;
    const maximum = Math.min(settings.maxTotalEffectSeconds, duration * settings.maxCoverage);
    for (const row of candidates) {
        if (kept.length >= settings.maxMoments) break;
        if (kept.length && row.start - kept.at(-1).end < settings.minGapSeconds) continue;
        if (total + (row.end - row.start) > maximum + .001) continue;
        kept.push(row);
        total = round(total + row.end - row.start);
    }
    return validateMoments({ moments: kept }, speech, duration, settings);
}

function validateCreativePlan(raw, moments, sourceId, duration, settings, assets = {}, evidence = {}, options = {}) {
    if (!Array.isArray(raw?.effects) || raw.effects.length > settings.maxMoments) throw new Error('Invalid creative effects');
    const seen = new Set(), zoomIssues = [], usedChat = new Set();
    const effects = raw.effects.map(row => {
        const moment = moments.find(item => item.id === row?.momentId);
        if (!moment || seen.has(moment.id) || typeof row.reason !== 'string' || !row.reason.trim() || row.reason.length > 300) {
            throw new Error('Unknown/duplicate creative moment');
        }
        seen.add(moment.id);
        if (row.visualConfirmed !== true || !Array.isArray(row.frameIds)
            || row.frameIds.length !== 3 || new Set(row.frameIds).size !== 3
            || row.frameIds.some(id => ![0, 1, 2].map(i => `${moment.id}F${i}`).includes(id))) throw new Error('Missing visual evidence');
        const effect = { ...moment, reason: row.reason, frameIds: row.frameIds };
        if (row.focusInset != null) {
            if (row.zoom || row.faceInset) throw new Error('Choose one focus presentation per moment');
            effect.focusInset = require('./focus_inset').validateFocusInset(row.focusInset);
            if (effect.focusInset.target === 'chat' && !settings.chatInset) throw new Error(
                `${moment.id}.focusInset target=chat is disabled for this edit: enlarging the chat column never isolates one line `
                + '(three lines at once read as noise) and it covers the game during a fight. Quote the line with '
                + 'danmaku={text,style:"scroll"|"bubble",y} instead, or drop the effect. Chat enlargement is only used when '
                + 'the operator explicitly asks for enlarged chat.');
        }
        if (row.faceInset != null) {
            if (row.zoom != null && (row.faceInset.mode !== 'retain' || row.zoom.target !== 'detail')) throw new Error('Only an unscaled retained face can accompany a detail zoom');
            effect.faceInset = require('./face_inset').validateFaceInset(row.faceInset);
            // The clock in the bottom-right corner looks like a small bright object and the
            // model keeps framing it as a face; a face box that reaches into that corner is
            // almost always the timestamp, which would blow the clock up instead of 岁己.
            const stamp = effect.faceInset.sourceBox;
            if (stamp.x + stamp.width > .86 && stamp.y + stamp.height > .86) throw new Error(
                `${moment.id}.faceInset.sourceBox ${JSON.stringify(stamp)} covers the bottom-right clock/timestamp overlay. `
                + 'That is the stream clock, not a face. Frame the avatar face itself (eyes, mouth, chin) and keep the box '
                + 'clear of the bottom-right corner.');
        }
        if (row.zoom != null) {
            const invalid = (field, requirement) => zoomIssues.push(`${moment.id}.zoom.${field} ${requirement} (got ${JSON.stringify(row.zoom[field])})`);
            if (!finite(row.zoom.scale, 1.15, settings.maxZoom)) invalid('scale', `must be a number in [1.15, ${settings.maxZoom}]`);
            for (const axis of ['x', 'y']) if (!finite(row.zoom[axis], 0, 1)) invalid(axis, 'must be a number in [0, 1]');
            if (!['avatar', 'detail'].includes(row.zoom.target)) invalid('target', 'must be avatar or detail');
            if (row.zoom.safeToCrop !== true) invalid('safeToCrop', 'must be true; remove an unsafe/unconfirmed crop with zoom=null, preserving other valid effects; never change the safety flag just to pass validation');
            effect.zoom = { scale: row.zoom.scale, x: row.zoom.x, y: row.zoom.y, target: row.zoom.target };
            if (settings.style === 'compact') {
                const box = row.zoom.targetBox;
                if (!box || !finite(box.x, 0, 1) || !finite(box.y, 0, 1) || !finite(box.width, .025, .8)
                    || !finite(box.height, .025, .8) || box.x + box.width > 1 || box.y + box.height > 1) invalid('targetBox', 'requires the visible face or key object bounds in one source frame');
                else {
                    const size = 1 / row.zoom.scale, left = Math.max(0, Math.min(1 - size, row.zoom.x - size / 2)), top = Math.max(0, Math.min(1 - size, row.zoom.y - size / 2));
                    if (box.x < left - .015 || box.y < top - .015 || box.x + box.width > left + size + .015 || box.y + box.height > top + size + .015) invalid('targetBox', 'the crop must contain the confirmed face/key object');
                    effect.zoom.targetBox = box;
                }
            }
        }
        if (row.sticker != null) {
            const s = row.sticker, anchored = s.anchorBox != null;
            // 贴纸挂在主体上时主体可能就贴边（右下角头像），x/y 都要放宽：汗滴必须落在头像头顶，
            // 而岁己的头像本来就在 y≈.75 一带。未锚定的贴纸仍收在中间区域。
            const [xMin, xMax] = anchored ? [.02, .98] : [.1, .9];
            const [yMin, yMax] = anchored ? [.02, .85] : [.12, .65];
            if ((!isSticker(s.id) && assets[s.id]?.kind !== 'sticker')
                || !finite(s.x, xMin, xMax) || !finite(s.y, yMin, yMax)
                || !finite(s.width ?? .2, .08, .30)
                || !['static', 'pop', 'slide'].includes(s.motion) || s.clearOfSubject !== true) throw new Error(
                `Invalid sticker/safe area: ${s.id} needs x ${xMin}–${xMax}${anchored ? ' (anchored to a subject)' : ''}, `
                + `y ${yMin}–${yMax}, width .08–.30, motion static/pop/slide, clearOfSubject true; got x=${s.x} y=${s.y} width=${s.width}`);
            effect.sticker = { id: s.id, x: s.x, y: s.y, width: s.width ?? .2, motion: s.motion };
            if (row.sticker.anchorBox) {
                const b = row.sticker.anchorBox;
                if (![b.x, b.y, b.width, b.height].every(Number.isFinite) || b.x < 0 || b.y < 0 || b.width <= 0 || b.height <= 0
                    || b.x + b.width > 1 || b.y + b.height > 1) throw new Error('Invalid sticker subject anchor');
                if (b.x + b.width > .86 && b.y + b.height > .86) throw new Error(
                    `${moment.id}.sticker.anchorBox ${JSON.stringify(b)} is the bottom-right clock/timestamp overlay, not the avatar. `
                    + 'Anchor the sticker to the character face instead.');
                effect.sticker.anchorBox = { ...b };
            }
        }
        if (row.danmaku != null) {
            const d = row.danmaku, style = d.style ?? 'scroll';
            const text = typeof d.text === 'string' ? d.text.trim() : '';
            if (!DANMAKU_STYLES.includes(style)) throw new Error(`${moment.id}.danmaku.style must be scroll or bubble, got ${JSON.stringify(d.style)}`);
            if (!text || text.length > 40) throw new Error(`${moment.id}.danmaku.text must quote one real chat line (<=40 chars), got ${JSON.stringify(d.text)}`);
            const y = d.y ?? (style === 'bubble' ? .14 : .18);
            if (!finite(y, .06, style === 'bubble' ? .45 : .60) || !finite(d.size ?? 1, .8, 1.6)) throw new Error(
                `${moment.id}.danmaku needs y ${style === 'bubble' ? '.06–.45' : '.06–.60'} (keep clear of the subtitle bar) and size .8–1.6`);
            // A danmaku card is a quote, not a paraphrase: it has to exist in the chat
            // evidence for this clip, otherwise the edit invents viewer reaction.
            const pool = Array.isArray(evidence.audience) ? evidence.audience.map(row => chatKey(row?.text ?? row)) : [];
            if (pool.length && !pool.some(line => line.includes(chatKey(text)))) throw new Error(
                `${moment.id}.danmaku.text must be copied from the provided audience chat, not written: ${JSON.stringify(text)}. `
                + `Real lines near this moment: ${JSON.stringify(pool.slice(0, 6))}`);
            effect.danmaku = { text, style, y, size: d.size ?? 1 };
            usedChat.add(text);
        } else if (settings.danmakuRequired) {
            // The model keeps dropping the quoted chat even when the pool is right there.
            // Pick a real line here instead: still a verbatim quote, never invented, and the
            // operator's "one line per node" requirement is guaranteed.
            const text = pickDanmaku(evidence.chatByMoment?.[moment.id] || [], usedChat);
            if (text) {
                usedChat.add(text);
                effect.danmaku = { text, style: text.length <= 10 ? 'bubble' : 'scroll', y: text.length <= 10 ? .13 : .16, size: 1 };
            }
        }
        if (row.sound != null) {
            const id = soundId(row.sound), offset = row.sound.offsetSeconds ?? 0, level = row.sound.levelDb ?? -10;
            const maxOffset = row.sound.followCueEnd !== undefined ? duration - moment.start - .3
                : Math.min(moment.end - moment.start + 1.5, duration - moment.start - .3);
            const soundSeconds = assets[id]?.sampleSeconds ?? SOUNDS[id]?.duration;
            const remaining = duration - moment.start - offset;
            const truncatedEnding = settings.style === 'compact' && Number.isFinite(offset)
                && offset >= 0 && remaining < Math.min(soundSeconds, 1.2) - .001;
            const enabled = Boolean(settings.soundEffects) && (Object.hasOwn(SOUNDS, id) || assets[id]?.kind === 'sound');
            // The reuse pass aims straight at the printed upper bound, so a sub-millisecond
            // float overshoot must not fail the whole plan; real outliers still do.
            const offsetOk = truncatedEnding || finite(offset, 0, maxOffset + 1e-6);
            const [levelMin, levelMax] = settings.style === 'compact' ? [-12, 0] : [-20, -6];
            if (!enabled || !offsetOk || !finite(level, levelMin, levelMax)) {
                throw new Error(`Invalid sound for ${moment.id}: ${id} must be enabled and available; `
                    + `offsetSeconds must be 0..${Math.max(0, maxOffset).toFixed(3)}, levelDb must be ${levelMin}..${levelMax}; `
                    + `got id=${id} enabled=${enabled} offsetSeconds=${JSON.stringify(row.sound.offsetSeconds)} `
                    + `levelDb=${JSON.stringify(row.sound.levelDb)} (clip ${duration}s, moment ${moment.start}–${moment.end}s)`);
            }
            if (!truncatedEnding) {
                if (row.sound.durationSeconds !== undefined && !finite(row.sound.durationSeconds, .1, soundSeconds)) throw new Error('Invalid sound excerpt duration');
                effect.sound = typeof row.sound === 'string' ? row.sound : { id, offsetSeconds: offset, levelDb: level,
                    ...(row.sound.followCueEnd !== undefined ? { followCueEnd: row.sound.followCueEnd } : {}),
                    ...(row.sound.durationSeconds !== undefined ? { durationSeconds: row.sound.durationSeconds } : {}),
                    ...(row.sound.afterCueId ? { afterCueId: row.sound.afterCueId } : {}) };
            }
        }
        if (row.filter != null) {
            const filter = typeof row.filter === 'object' && row.filter && Object.keys(row.filter).length === 1
                ? row.filter.id : row.filter;
            if (!settings.filters || typeof filter !== 'string' || !Object.hasOwn(FILTERS, filter)) {
                throw new Error(`${moment.id}.filter must be one of ${Object.keys(FILTERS).join(',')} as a string or {id}; timed filters are unsupported, use the whole moment or filter=null`);
            }
            effect.filter = filter;
        }
        return effect;
    }).filter(row => row.zoom || row.faceInset || row.focusInset || row.sticker || row.danmaku || row.filter || row.sound)
        .sort((a, b) => a.start - b.start);
    // Report all failed crops in the single repair attempt; never render an unconfirmed crop.
    if (zoomIssues.length) throw new Error(`Invalid zoom region: ${zoomIssues.join('; ')}`);
    // Per-node check first (the model tends to drop the whole effect instead of adding
    // a danmaku), then fill the remaining nodes here so a quoted chat layer always exists.
    if (settings.danmakuRequired && options.fillDanmaku !== false) {
        const budget = Math.min(settings.maxTotalEffectSeconds, duration * settings.maxCoverage);
        let spent = effects.reduce((total, effect) => total + effect.end - effect.start, 0);
        for (const moment of moments) {
            if (effects.some(effect => effect.id === moment.id)) continue;
            const text = pickDanmaku(evidence.chatByMoment?.[moment.id] || [], usedChat);
            if (!text) continue;
            const seconds = moment.end - moment.start;
            if (spent + seconds > budget + .001) continue;
            if (effects.some(effect => effect.start < moment.end + settings.minGapSeconds && effect.end > moment.start - settings.minGapSeconds)) continue;
            usedChat.add(text);
            spent += seconds;
            effects.push({ id: moment.id, start: moment.start, end: moment.end, frameIds: [],
                reason: '观众弹幕：本节点没有其他画面效果，只引一条真实聊天',
                danmaku: { text, style: text.length <= 10 ? 'bubble' : 'scroll', y: text.length <= 10 ? .13 : .16, size: 1 } });
        }
        effects.sort((a, b) => a.start - b.start);
    }
    const plan = { version: 2, workflow: 'creative', style: settings.style, sourceId, duration, effects };
    if (settings.style === 'compact') {
        plan.audioAdjustments = raw.effects.filter(row => row.sound && !effects.find(effect => effect.id === row.momentId)?.sound)
            .map(row => ({ momentId: row.momentId, sound: soundId(row.sound), reason: 'avoid_truncated_end_sound' }));
        const sounding = effects.filter(row => row.sound).map(row => ({ row, start: row.start + (row.sound.offsetSeconds || 0),
            seconds: row.sound.durationSeconds ?? assets[soundId(row.sound)]?.sampleSeconds ?? SOUNDS[soundId(row.sound)]?.duration })).sort((a, b) => a.start - b.start);
        const accepted = [];
        for (const sound of sounding) {
            const collision = accepted.find(other => other.row.sound && sound.start < other.start + other.seconds && other.start < sound.start + sound.seconds);
            if (!collision) { accepted.push(sound); continue; }
            const preferNew = assets[soundId(sound.row.sound)]?.kind === 'sound' && !assets[soundId(collision.row.sound)];
            const omitted = preferNew ? collision : sound;
            plan.audioAdjustments.push({ momentId: omitted.row.id, sound: soundId(omitted.row.sound), reason: 'avoid_overlapping_reaction_sounds' });
            delete omitted.row.sound;
            if (preferNew) accepted.push(sound);
        }
        plan.effects = effects.filter(row => row.zoom || row.faceInset || row.focusInset || row.sticker || row.danmaku || row.sound || row.filter);
    }
    assertRenderPlan(plan, duration, settings, assets, true);
    return plan;
}

function assTime(time) {
    const n = Math.round(time * 100);
    return `${Math.floor(n / 360000)}:${String(Math.floor(n / 6000) % 60).padStart(2, '0')}:${String(Math.floor(n / 100) % 60).padStart(2, '0')}.${String(n % 100).padStart(2, '0')}`;
}

// ASS has no user text escaping, so a quoted chat line must not smuggle in override
// blocks or drawing commands.
const assText = text => String(text).replace(/\\/g, '＼').replace(/[{}]/g, '').replace(/[\r\n]+/g, ' ').trim();

// A rounded box for a speech bubble. libass paints BorderStyle=3 very faintly through
// ffmpeg's filter, so the box is drawn with \p1 where colour and alpha are explicit.
function roundedRect(w, h, r) {
    const p = (x, y) => `${Math.round(x)} ${Math.round(y)}`, k = r / 3;
    return `m ${p(r, 0)} l ${p(w - r, 0)} b ${p(w - r + k, 0)} ${p(w, 0)} ${p(w, k)} ${p(w, r)}`
        + ` l ${p(w, h - r)} b ${p(w, h - r + k)} ${p(w, h)} ${p(w - r + k, h)} ${p(w - r, h)}`
        + ` l ${p(r, h)} b ${p(r - k, h)} ${p(0, h)} ${p(0, h - r + k)} ${p(0, h - r)}`
        + ` l ${p(0, r)} b ${p(0, k)} ${p(r - k, 0)} ${p(r, 0)}`;
}

function stickerAss(plan, width, height, font = 'Arial') {
    const rollSize = Math.round(height * .044), bubbleSize = Math.round(height * .040);
    const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Accent,Arial,${Math.round(height * .12)},&H007BEEFF,&H007BEEFF,&H00252335,&H70000000,-1,0,0,0,100,100,0,0,1,${Math.max(2, Math.round(height * .006))},2,5,0,0,0,1\nStyle: Danmaku,${font},${rollSize},&H00FFFFFF,&H00FFFFFF,&H00101010,&H00000000,-1,0,0,0,100,100,.6,0,1,${Math.max(2, Math.round(height * .0045))},1,7,0,0,0,1\nStyle: Bubble,${font},${bubbleSize},&H00FFFFFF,&H00FFFFFF,&H00141010,&H00000000,-1,0,0,0,100,100,.4,0,1,2,1,7,0,0,0,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
    const symbols = plan.effects.filter(row => row.sticker && isSticker(row.sticker.id)).map(row => {
        const s = row.sticker;
        const motion = s.motion === 'pop' ? '\\fscx60\\fscy60\\t(0,100,\\fscx115\\fscy115)\\t(100,220,\\fscx100\\fscy100)' : '';
        // 字形贴纸只是排版符号；实物和表情贴纸一律走素材清单，由 overlay 合成。
        return `Dialogue: 0,${assTime(row.start)},${assTime(row.end)},Accent,,0,0,0,,{\\an5\\pos(${Math.round(s.x * width)},${Math.round(s.y * height)})\\fad(60,100)${motion}}${STICKERS[s.id]}`;
    });
    // A quoted chat line flies through (Bilibili style) or sits in a bubble. Both keep the
    // game visible and single out one line, which enlarging the whole column cannot do.
    const danmakuLines = plan.effects.filter(row => row.danmaku).map(row => {
        const d = row.danmaku, text = assText(d.text), size = Math.round((d.style === 'bubble' ? bubbleSize : rollSize) * (d.size ?? 1));
        const top = Math.round(d.y * height);
        if (d.style === 'bubble') {
            const pop = '\\fscx70\\fscy70\\t(0,130,\\fscx104\\fscy104)\\t(130,250,\\fscx100\\fscy100)';
            // One quoted line per bubble, but a quote longer than the frame gets squeezed
            // into a hair-thin banner nobody can read, so wrap it and grow the box instead.
            const rawText = String(d.text).trim();
            const budget = Math.max(6, Math.floor(width * .44 / size));
            const count = Math.min(3, Math.ceil(rawText.length / budget)), per = Math.ceil(rawText.length / count);
            const lines = Array.from({ length: count }, (_, index) => rawText.slice(index * per, (index + 1) * per)).filter(Boolean);
            const longest = Math.max(...lines.map(line => line.length));
            const padX = Math.round(size * .72), boxW = Math.round(longest * size * 1.04 + padX * 2);
            const boxH = Math.round(size * 1.78 + (lines.length - 1) * size * 1.3), left = Math.round((width - boxW) / 2), radius = Math.round(size * .42);
            const bg = `Dialogue: 1,${assTime(row.start)},${assTime(row.end)},Accent,,0,0,0,,`
                + `{\\an7\\pos(${left},${top})\\p1\\bord0\\shad0\\1c&H0E0A07&\\1a&H34&\\fad(120,180)}${roundedRect(boxW, boxH, radius)}`;
            return bg + `\nDialogue: 2,${assTime(row.start)},${assTime(row.end)},Bubble,,0,0,0,,`
                + `{\\an7\\pos(${left + padX},${Math.round(top + (boxH - size * 1.18 - (lines.length - 1) * size * 1.3) / 2)})\\fs${size}\\fad(120,180)${pop}}`
                + lines.map(assText).join('\\N');
        }
        // Constant reading speed across resolutions; the line enters fully out of frame and
        // leaves it, so a short moment never turns into a streak.
        const travel = width + text.length * size, seconds = Math.max(2.4, Math.min(5.2, travel / (width * .34)));
        const end = Math.min(plan.duration ?? row.end, row.start + seconds + .2);
        return `Dialogue: 2,${assTime(row.start)},${assTime(end)},Danmaku,,0,0,0,,{\\an7\\move(${Math.round(width + 24)},${top},${-Math.round(text.length * size + 60)},${top})\\fs${size}\\fad(80,80)}${text}`;
    });
    const borders = plan.effects.filter(row => row.faceInset || row.focusInset).map(row => {
        const b = row.focusInset ? require('./focus_inset').focusBorderDrawing(row.focusInset, width, height)
            : require('./face_inset').insetBorderDrawing(row.faceInset, width, height);
        return `Dialogue: 0,${assTime(row.start)},${assTime(row.end)},Accent,,0,0,0,,{\\an7\\pos(${b.x},${b.y})\\p1\\bord${b.border}\\shad0\\1a&HFF&\\3c&HFFFFFF&}${b.path}`;
    });
    const context = plan.contextQuestion ? require('../workflow-runtime').loadWorkflow('clipping/creativeContext').contextAss(plan.contextQuestion, width, height) : null;
    return header + [...symbols, ...danmakuLines, ...borders, ...(context ? [context] : [])].join('\n') + '\n';
}

const escapePath = file => String(file).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\''");

function assertRenderPlan(plan, duration, rawSettings, assets = {}, allowEmpty = false) {
    const limits = creativeSettings(rawSettings);
    if (plan.timeline) {
        require('./creative_timeline').assertTimeline(plan.timeline, duration);
        if (Math.abs(plan.duration - plan.timeline.duration) > .002) throw new Error('Creative timeline duration mismatch');
        duration = plan.duration;
    }
    if (![1, 2].includes(plan?.version) || plan.workflow !== 'creative' || !finite(plan.duration, .6, 86400)
        || Math.abs(plan.duration - duration) > .001 || !Array.isArray(plan.effects)
        || (!allowEmpty && !plan.effects.length && !plan.contextQuestion && !(plan.timeline?.sourceDuration - plan.timeline?.duration > .001))
        || plan.effects.length > limits.maxMoments) throw new Error('Invalid creative render plan');
    if (plan.contextQuestion) require('../workflow-runtime').loadWorkflow('clipping/creativeContext').contextAss(plan.contextQuestion, 1920, 1080);
    for (const [index, row] of plan.effects.entries()) {
        if (!finite(row.start, 0, duration) || !finite(row.end, row.start + .6 - 1e-6, Math.min(duration, row.start + limits.maxEffectSeconds + 1e-6))
            || (index && round(row.start - plan.effects[index - 1].end) < limits.minGapSeconds)
            || (!row.zoom && !row.faceInset && !row.focusInset && !row.sticker && !row.danmaku && !row.filter && !row.sound)) throw new Error('Invalid creative render timing');
        if (row.focusInset) { if (row.zoom || row.faceInset) throw new Error('Conflicting focus operations'); require('./focus_inset').validateFocusInset(row.focusInset); }
        if (row.faceInset) { if (row.zoom && (row.faceInset.mode !== 'retain' || row.zoom.target !== 'detail')) throw new Error('Inset conflicts with full-frame zoom'); require('./face_inset').validateFaceInset(row.faceInset); }
        if (row.zoom && (!finite(row.zoom.scale, 1.15, limits.maxZoom) || !finite(row.zoom.x, 0, 1) || !finite(row.zoom.y, 0, 1))) throw new Error('Invalid render zoom');
        if (row.sticker && ((!isSticker(row.sticker.id) && assets[row.sticker.id]?.kind !== 'sticker') || !finite(row.sticker.x, row.sticker.anchorBox != null ? .02 : .1, row.sticker.anchorBox != null ? .98 : .9)
            || !finite(row.sticker.y, row.sticker.anchorBox != null ? .02 : .12, row.sticker.anchorBox != null ? .85 : .65) || !finite(row.sticker.width ?? .2, .08, .30)
            || !finite(row.sticker.heightLimit ?? .35, .08, .35)
            || !['static', 'pop', 'slide'].includes(row.sticker.motion))) throw new Error('Invalid render sticker');
        if (row.sound && (!limits.soundEffects || (!Object.hasOwn(SOUNDS, soundId(row.sound)) && assets[soundId(row.sound)]?.kind !== 'sound')
            || !finite(row.sound.offsetSeconds ?? 0, 0, row.sound.followCueEnd !== undefined
                ? duration - row.start - .3 : Math.min(row.end - row.start + 1.5, duration - row.start - .3)) || !finite(row.sound.levelDb ?? -10, limits.style === 'compact' ? -12 : -20, limits.style === 'compact' ? 0 : -6))) throw new Error('Invalid render sound');
        if (row.sound?.durationSeconds !== undefined && !finite(row.sound.durationSeconds, .1, assets[soundId(row.sound)]?.sampleSeconds ?? SOUNDS[soundId(row.sound)]?.duration)) throw new Error('Invalid render sound excerpt');
        if (row.filter && (!limits.filters || !Object.hasOwn(FILTERS, row.filter))) throw new Error('Invalid render filter');
        if (row.danmaku && (!DANMAKU_STYLES.includes(row.danmaku.style) || typeof row.danmaku.text !== 'string' || !row.danmaku.text.trim()
            || row.danmaku.text.length > 40 || !finite(row.danmaku.y, .06, row.danmaku.style === 'bubble' ? .45 : .60)
            || !finite(row.danmaku.size ?? 1, .8, 1.6))) throw new Error('Invalid render danmaku');
    }
    if (plan.effects.reduce((n, row) => n + row.end - row.start, 0) > Math.min(limits.maxTotalEffectSeconds, duration * limits.maxCoverage)) throw new Error('Excess creative render coverage');
    const families = ['zoom', 'faceInset', 'focusInset', 'sticker', 'danmaku', 'sound', 'filter'].filter(key => plan.effects.some(row => row[key]));
    if (limits.variety && plan.effects.length >= 2 && families.length < 2) throw new Error('Variety edit needs at least two suitable effect families; avoid zoom-only output');
    if (plan.music && (limits.style !== 'compact' || limits.music === false || assets[plan.music.id]?.kind !== 'music'
        || !finite(plan.music.levelDb, -32, -22))) throw new Error('Invalid background music');
}

const SPEED_BADGE_FONTS = Object.freeze([process.env.CLIP_BADGE_FONT, 'C:/Windows/Fonts/msyhbd.ttc', 'C:/Windows/Fonts/msyh.ttc',
    '/System/Library/Fonts/PingFang.ttc', '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc'].filter(Boolean));

function speedBadgeFont() {
    const found = SPEED_BADGE_FONTS.find(file => { try { return require('fs').existsSync(file); } catch { return false; } });
    return found || '';
}

// A fast-forward has to look deliberate: every accelerated span carries its rate and
// duration on screen, so the jump reads as an editorial choice rather than as dropped
// frames. A silent fallback is acceptable — the timeline still records the badge.
function speedBadgeFilter(plan, height, font = speedBadgeFont()) {
    if (!plan.timeline) return '';
    const badges = require('./creative_timeline').speedBadges(plan.timeline);
    if (!badges.length || !font) return '';
    const size = Math.max(16, Math.round(height * .038)), pad = Math.max(6, Math.round(size * .34));
    const margin = Math.round(height * .05);
    return badges.map(row => `drawtext=fontfile='${escapePath(font)}':text='${row.text}':fontcolor=white:fontsize=${size}:`
        + `box=1:boxcolor=black@0.55:boxborderw=${pad}:x=w-tw-${margin}:y=${margin}:`
        + `enable='between(t,${row.start},${row.end})'`).join(',') + ',';
}

/** Effects precede the normal subtitle burn. Audio keeps its full original timeline. */
function buildCreativeFilter(plan, resolution, trimStart, trimEnd, subtitlePath, stickerPath, bindings = {}, videoOverlay = '') {
    const { width, height } = resolution;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2
        || !finite(trimStart, 0, 1e9) || !finite(trimEnd, trimStart, 1e9)) throw new Error('Invalid creative render dimensions/window');
    const graph = [];
    if (plan.timeline) {
        require('./creative_timeline').assertTimeline(plan.timeline, trimEnd - trimStart);
        const { audioPieceFilter, speedOf, pieceSeconds } = require('./creative_timeline');
        const pieces = plan.timeline.holds?.length ? require('../workflow-runtime').loadWorkflow('clipping/enhancement').reactionPieces(plan.timeline)
            : plan.timeline.keep.map(s => ({ ...s, hold: 0 }));
        // Mixed playback rates need one constant rate before concat, otherwise the
        // joined stream is variable frame rate and the burned captions drift.
        const accelerated = pieces.some(piece => speedOf(piece) > 1);
        const frameRate = Number(resolution.frameRate);
        const normalise = accelerated && Number.isFinite(frameRate) && frameRate >= 10 && frameRate <= 120
            ? `,fps=${round(frameRate)}` : '';
        pieces.forEach((s, i) => {
            const speed = speedOf(s), seconds = pieceSeconds(s);
            graph.push(
                `[0:v:0]trim=start=${trimStart + s.start}:end=${trimStart + s.end},`
                    + (speed > 1 ? `setpts=(PTS-STARTPTS)/${round(speed)}` : 'setpts=PTS-STARTPTS') + normalise + ',setsar=1'
                    + (s.hold ? `,tpad=stop_mode=clone:stop_duration=${s.hold},trim=duration=${round(seconds + s.hold)}` : '') + `[tv${i}]`,
                audioPieceFilter('0:a:0', trimStart + s.start, trimStart + s.end, s.hold, `ta${i}`, speed));
        });
        // Joint A/V concat pads each audio section to the last video frame, accumulating dialogue drift.
        graph.push(`${pieces.map((_, i) => `[tv${i}]`).join('')}concat=n=${pieces.length}:v=1:a=0[cv0]`,
            `${pieces.map((_, i) => `[ta${i}]`).join('')}concat=n=${pieces.length}:v=0:a=1[ca0]`);
    } else graph.push(`[0:v:0]trim=start=${trimStart}:end=${trimEnd},setpts=PTS-STARTPTS,setsar=1[cv0]`,
        `[0:a:0]atrim=start=${trimStart}:end=${trimEnd},asetpts=PTS-STARTPTS[ca0]`);
    let video = 'cv0';
    plan.effects.forEach((row, index) => {
        const gate = `gte(t,${row.start})*lt(t,${row.end})`;
        const retainFace = row.zoom && row.faceInset?.mode === 'retain';
        if (retainFace) { graph.push(`[${video}]split=2[detailbase${index}][originalface${index}]`); video = `detailbase${index}`; }
        if (row.faceInset && !retainFace) {
            const inset = require('./face_inset').faceInsetFilters(video, row, index, width, height, row.filter ? FILTERS[row.filter] : null);
            graph.push(...inset.lines); video = inset.output;
        }
        if (row.focusInset) {
            const inset = require('./focus_inset').focusInsetFilters(video, row, index, width, height, row.filter ? FILTERS[row.filter] : null);
            graph.push(...inset.lines); video = inset.output;
        }
        if (row.zoom) {
            const z = row.zoom, w = Math.floor(width / z.scale / 2) * 2, h = Math.floor(height / z.scale / 2) * 2;
            const x = Math.round(Math.max(0, Math.min(width - w, z.x * width - w / 2)) / 2) * 2;
            let top = Math.max(0, Math.min(height - h, z.y * height - h / 2));
            const face = plan.style === 'compact' && z.target === 'avatar' && z.targetBox;
            if (face) top = Math.max(0, Math.min(height - h, z.targetBox.y * height,
                Math.max(top, (z.targetBox.y + z.targetBox.height + .08) * height - h)));
            const y = Math.round(top / 2) * 2;
            const scaledHeight = face ? Math.floor(height * .88 / 2) * 2 : height;
            const scaledWidth = face ? Math.floor(width * .88 / 2) * 2 : width;
            graph.push(`[${video}]split=2[base${index}][focus${index}]`,
                `[focus${index}]trim=start=${row.start}:end=${row.end},crop=${w}:${h}:${x}:${y},scale=${scaledWidth}:${scaledHeight}`
                    + (face ? `,pad=${width}:${height}:${(width - scaledWidth) / 2}:0:color=0x16161b` : '') + `,setsar=1[zoom${index}]`,
                `[base${index}][zoom${index}]overlay=0:0:enable='${gate}':eof_action=pass:repeatlast=0[zv${index}]`);
            video = `zv${index}`;
        }
        if (row.filter && (!row.faceInset || retainFace) && !row.focusInset) { graph.push(`[${video}]${FILTERS[row.filter]}:enable='${gate}'[fv${index}]`); video = `fv${index}`; }
        if (retainFace) {
            const inset = require('./face_inset').faceInsetFilters(video, row, index, width, height, null, `originalface${index}`);
            graph.push(...inset.lines); video = inset.output;
        }
        const picture = bindings[`${index}:sticker`];
        if (picture) {
            const s = row.sticker, duration = row.end - row.start;
            const w = Math.round(width * (s.width ?? .2) / 2) * 2, h = Math.round(height * (s.heightLimit ?? .35) / 2) * 2;
            graph.push(`[${picture.inputIndex}:v:0]loop=loop=-1:size=1:start=0,setpts=N/(25*TB),trim=duration=${duration},`
                + `scale=${w}:${h}:force_original_aspect_ratio=decrease,setsar=1,format=rgba,fade=t=in:st=0:d=0.10:alpha=1,`
                + `fade=t=out:st=${Math.max(0, duration - .16)}:d=0.16:alpha=1,setpts=PTS-STARTPTS+${row.start}/TB[png${index}]`);
            const x = `max(0,min(W-w,${s.x}*W-w/2))` + (s.motion === 'slide' ? `-W*0.12*max(0,1-(t-${row.start})/0.25)` : '');
            const y = `max(0,min(H*0.8-h,${s.y}*H-h/2))` + (s.motion === 'pop' ? `+H*0.025*exp(-12*(t-${row.start}))*cos(18*(t-${row.start}))` : '');
            graph.push(`[${video}][png${index}]overlay=x='${x}':y='${y}':enable='${gate}':eof_action=pass:repeatlast=0[pv${index}]`);
            video = `pv${index}`;
        }
    });
    const badges = speedBadgeFilter(plan, height);
    const overlays = stickerPath ? `ass='${escapePath(stickerPath)}',` : '';
    graph.push(`[${video}]${videoOverlay}${badges}${overlays}subtitles='${escapePath(subtitlePath)}'[vout]`);
    const sounds = plan.effects.map((row, index) => ({ row, index })).filter(({ row }) => row.sound);
    sounds.forEach(({ row, index }, soundIndex) => {
        const asset = bindings[`${index}:sound`], sound = SOUNDS[soundId(row.sound)];
        const offset = row.sound.offsetSeconds ?? 0;
        const duration = Math.min(row.sound.durationSeconds ?? (asset ? asset.asset.sampleSeconds : sound.duration), plan.duration - row.start - offset);
        const compact = plan.style === 'compact';
        const input = asset ? `[${asset.inputIndex}:a:0]atrim=start=${asset.asset.sampleStart}:duration=${duration},asetpts=PTS-STARTPTS,`
            + (compact ? `loudnorm=I=-16:TP=-2:LRA=7,volume=${row.sound.levelDb ?? -3}dB` : `volume=${row.sound.levelDb ?? -10}dB`)
            : `sine=frequency=${sound.frequency}:sample_rate=48000:duration=${duration},` + (compact ? `volume=4,volume=${row.sound.levelDb ?? -8}dB` : 'volume=0.35');
        const fadeOut = compact ? Math.min(.2, duration / 3) : .2;
        graph.push(`${input},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,afade=t=in:st=0:d=${compact ? Math.min(.025, duration / 10) : .025},`
            + `afade=t=out:st=${Math.max(0, duration - fadeOut)}:d=${fadeOut},adelay=${Math.round((row.start + offset) * 1000)}:all=1[sfx${soundIndex}]`);
    });
    const music = plan.music && bindings.music;
    if (sounds.length || music) {
        graph.push(`[ca0]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asplit=${1 + Number(!!sounds.length) + Number(!!music)}[original]${sounds.length ? '[voice]' : ''}${music ? '[musicvoice]' : ''}`);
        if (sounds.length) graph.push(
            `${sounds.map((_, i) => `[sfx${i}]`).join('')}amix=inputs=${sounds.length}:duration=longest:normalize=0[accents]`,
            `[accents][voice]sidechaincompress=threshold=${plan.style === 'compact' ? '0.18:ratio=2' : '0.04:ratio=5'}:attack=8:release=180:makeup=1[ducked]`);
        if (music) graph.push(`[${music.inputIndex}:a:0]aresample=48000,aloop=loop=-1:size=${Math.round(music.asset.sampleSeconds * 48000)},atrim=duration=${plan.duration},`
            + `asetpts=PTS-STARTPTS,loudnorm=I=${plan.music.levelDb}:TP=-4:LRA=7,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,`
            + `afade=t=in:d=0.3,afade=t=out:st=${Math.max(0, plan.duration - .8)}:d=0.8[musicbed]`,
            '[musicbed][musicvoice]sidechaincompress=threshold=0.12:ratio=2:attack=15:release=250:makeup=1[bgm]');
        graph.push(`[original]${sounds.length ? '[ducked]' : ''}${music ? '[bgm]' : ''}amix=inputs=${1 + Number(!!sounds.length) + Number(!!music)}:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95:level=false:latency=true[sub_a]`);
    } else graph.push('[ca0]anull[sub_a]');
    return graph.join(';');
}

module.exports = { STICKERS, isSticker, DANMAKU_STYLES, SOUNDS, FILTERS, creativeSettings, speechForCreative, validateMoments, sanitizeMoments, validateCreativePlan, assertRenderPlan, stickerAss, buildCreativeFilter, speedBadgeFilter, speedBadgeFont };
