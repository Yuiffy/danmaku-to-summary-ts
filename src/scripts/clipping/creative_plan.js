'use strict';

// A small closed vocabulary: model output never becomes a path, filter or ASS command.
const STICKERS = Object.freeze({ question: '?', surprise: '!', sparkle: '✦' });
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

function validateCreativePlan(raw, moments, sourceId, duration, settings, assets = {}) {
    if (!Array.isArray(raw?.effects) || raw.effects.length > settings.maxMoments) throw new Error('Invalid creative effects');
    const seen = new Set(), zoomIssues = [];
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
        }
        if (row.faceInset != null) {
            if (row.zoom != null && (row.faceInset.mode !== 'retain' || row.zoom.target !== 'detail')) throw new Error('Only an unscaled retained face can accompany a detail zoom');
            effect.faceInset = require('./face_inset').validateFaceInset(row.faceInset);
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
            if ((!Object.hasOwn(STICKERS, row.sticker.id) && assets[row.sticker.id]?.kind !== 'sticker')
                || !finite(row.sticker.x, .1, .9) || !finite(row.sticker.y, .12, .65)
                || !finite(row.sticker.width ?? .2, .08, .30)
                || !['static', 'pop', 'slide'].includes(row.sticker.motion) || row.sticker.clearOfSubject !== true) throw new Error('Invalid sticker/safe area');
            effect.sticker = { id: row.sticker.id, x: row.sticker.x, y: row.sticker.y, width: row.sticker.width ?? .2, motion: row.sticker.motion };
            if (row.sticker.anchorBox) {
                const b = row.sticker.anchorBox;
                if (![b.x, b.y, b.width, b.height].every(Number.isFinite) || b.x < 0 || b.y < 0 || b.width <= 0 || b.height <= 0
                    || b.x + b.width > 1 || b.y + b.height > 1) throw new Error('Invalid sticker subject anchor');
                effect.sticker.anchorBox = { ...b };
            }
        }
        if (row.sound != null) {
            const id = soundId(row.sound), offset = row.sound.offsetSeconds ?? 0, level = row.sound.levelDb ?? -10;
            const maxOffset = Math.min(moment.end - moment.start + 1.5, duration - moment.start - .3);
            const soundSeconds = assets[id]?.sampleSeconds ?? SOUNDS[id]?.duration;
            const remaining = duration - moment.start - offset;
            const truncatedEnding = settings.style === 'compact' && Number.isFinite(offset)
                && offset >= 0 && remaining < Math.min(soundSeconds, 1.2) - .001;
            if (!settings.soundEffects || (!Object.hasOwn(SOUNDS, id) && assets[id]?.kind !== 'sound')
                || (!truncatedEnding && !finite(offset, 0, maxOffset))
                || !finite(level, settings.style === 'compact' ? -12 : -20, settings.style === 'compact' ? 0 : -6)) {
                throw new Error(`Invalid sound for ${moment.id}: ${id} must be enabled and available; offsetSeconds must be 0..${Math.max(0, maxOffset).toFixed(3)}, levelDb must be ${settings.style === 'compact' ? '-12..0' : '-20..-6'}`);
            }
            if (!truncatedEnding) {
                effect.sound = typeof row.sound === 'string' ? row.sound : { id, offsetSeconds: offset, levelDb: level };
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
    }).filter(row => row.zoom || row.faceInset || row.focusInset || row.sticker || row.filter || row.sound)
        .sort((a, b) => a.start - b.start);
    // Report all failed crops in the single repair attempt; never render an unconfirmed crop.
    if (zoomIssues.length) throw new Error(`Invalid zoom region: ${zoomIssues.join('; ')}`);
    const plan = { version: 2, workflow: 'creative', style: settings.style, sourceId, duration, effects };
    if (settings.style === 'compact') {
        plan.audioAdjustments = raw.effects.filter(row => row.sound && !effects.find(effect => effect.id === row.momentId)?.sound)
            .map(row => ({ momentId: row.momentId, sound: soundId(row.sound), reason: 'avoid_truncated_end_sound' }));
        const sounding = effects.filter(row => row.sound).map(row => ({ row, start: row.start + (row.sound.offsetSeconds || 0),
            seconds: assets[soundId(row.sound)]?.sampleSeconds || SOUNDS[soundId(row.sound)]?.duration })).sort((a, b) => a.start - b.start);
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
        plan.effects = effects.filter(row => row.zoom || row.faceInset || row.focusInset || row.sticker || row.sound || row.filter);
    }
    assertRenderPlan(plan, duration, settings, assets, true);
    return plan;
}

function assTime(time) {
    const n = Math.round(time * 100);
    return `${Math.floor(n / 360000)}:${String(Math.floor(n / 6000) % 60).padStart(2, '0')}:${String(Math.floor(n / 100) % 60).padStart(2, '0')}.${String(n % 100).padStart(2, '0')}`;
}

function stickerAss(plan, width, height) {
    const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Accent,Arial,${Math.round(height * .12)},&H007BEEFF,&H007BEEFF,&H00252335,&H70000000,-1,0,0,0,100,100,0,0,1,${Math.max(2, Math.round(height * .006))},2,5,0,0,0,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
    const symbols = plan.effects.filter(row => row.sticker && Object.hasOwn(STICKERS, row.sticker.id)).map(row => {
        const s = row.sticker;
        const motion = s.motion === 'pop' ? '\\fscx60\\fscy60\\t(0,100,\\fscx115\\fscy115)\\t(100,220,\\fscx100\\fscy100)' : '';
        return `Dialogue: 0,${assTime(row.start)},${assTime(row.end)},Accent,,0,0,0,,{\\an5\\pos(${Math.round(s.x * width)},${Math.round(s.y * height)})\\fad(60,100)${motion}}${STICKERS[s.id]}`;
    });
    const borders = plan.effects.filter(row => row.faceInset || row.focusInset).map(row => {
        const b = row.focusInset ? require('./focus_inset').focusBorderDrawing(row.focusInset, width, height)
            : require('./face_inset').insetBorderDrawing(row.faceInset, width, height);
        return `Dialogue: 0,${assTime(row.start)},${assTime(row.end)},Accent,,0,0,0,,{\\an7\\pos(${b.x},${b.y})\\p1\\bord${b.border}\\shad0\\1a&HFF&\\3c&HFFFFFF&}${b.path}`;
    });
    return header + [...symbols, ...borders].join('\n') + '\n';
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
        || Math.abs(plan.duration - duration) > .001 || !Array.isArray(plan.effects) || (!allowEmpty && !plan.effects.length)
        || plan.effects.length > limits.maxMoments) throw new Error('Invalid creative render plan');
    for (const [index, row] of plan.effects.entries()) {
        if (!finite(row.start, 0, duration) || !finite(row.end, row.start + .6 - 1e-6, Math.min(duration, row.start + limits.maxEffectSeconds + 1e-6))
            || (index && round(row.start - plan.effects[index - 1].end) < limits.minGapSeconds)
            || (!row.zoom && !row.faceInset && !row.focusInset && !row.sticker && !row.filter && !row.sound)) throw new Error('Invalid creative render timing');
        if (row.focusInset) { if (row.zoom || row.faceInset) throw new Error('Conflicting focus operations'); require('./focus_inset').validateFocusInset(row.focusInset); }
        if (row.faceInset) { if (row.zoom && (row.faceInset.mode !== 'retain' || row.zoom.target !== 'detail')) throw new Error('Inset conflicts with full-frame zoom'); require('./face_inset').validateFaceInset(row.faceInset); }
        if (row.zoom && (!finite(row.zoom.scale, 1.15, limits.maxZoom) || !finite(row.zoom.x, 0, 1) || !finite(row.zoom.y, 0, 1))) throw new Error('Invalid render zoom');
        if (row.sticker && ((!Object.hasOwn(STICKERS, row.sticker.id) && assets[row.sticker.id]?.kind !== 'sticker') || !finite(row.sticker.x, row.sticker.anchor === 'subject' ? .02 : .1, row.sticker.anchor === 'subject' ? .98 : .9)
            || !finite(row.sticker.y, row.sticker.anchor === 'subject' ? .02 : .12, row.sticker.anchor === 'subject' ? .85 : .65) || !finite(row.sticker.width ?? .2, .08, .30)
            || !finite(row.sticker.heightLimit ?? .35, .08, .35)
            || !['static', 'pop', 'slide'].includes(row.sticker.motion))) throw new Error('Invalid render sticker');
        if (row.sound && (!limits.soundEffects || (!Object.hasOwn(SOUNDS, soundId(row.sound)) && assets[soundId(row.sound)]?.kind !== 'sound')
            || !finite(row.sound.offsetSeconds ?? 0, 0, Math.min(row.end - row.start + 1.5, duration - row.start - .3)) || !finite(row.sound.levelDb ?? -10, limits.style === 'compact' ? -12 : -20, limits.style === 'compact' ? 0 : -6))) throw new Error('Invalid render sound');
        if (row.filter && (!limits.filters || !Object.hasOwn(FILTERS, row.filter))) throw new Error('Invalid render filter');
    }
    if (plan.effects.reduce((n, row) => n + row.end - row.start, 0) > Math.min(limits.maxTotalEffectSeconds, duration * limits.maxCoverage)) throw new Error('Excess creative render coverage');
    const families = ['zoom', 'faceInset', 'focusInset', 'sticker', 'sound', 'filter'].filter(key => plan.effects.some(row => row[key]));
    if (limits.variety && plan.effects.length >= 2 && families.length < 2) throw new Error('Variety edit needs at least two suitable effect families; avoid zoom-only output');
    if (plan.music && (limits.style !== 'compact' || assets[plan.music.id]?.kind !== 'music'
        || !finite(plan.music.levelDb, -32, -22))) throw new Error('Invalid background music');
}

/** Effects precede the normal subtitle burn. Audio keeps its full original timeline. */
function buildCreativeFilter(plan, resolution, trimStart, trimEnd, subtitlePath, stickerPath, bindings = {}) {
    const { width, height } = resolution;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2
        || !finite(trimStart, 0, 1e9) || !finite(trimEnd, trimStart, 1e9)) throw new Error('Invalid creative render dimensions/window');
    const graph = [];
    if (plan.timeline) {
        require('./creative_timeline').assertTimeline(plan.timeline, trimEnd - trimStart);
        plan.timeline.keep.forEach((s, i) => graph.push(
            `[0:v:0]trim=start=${trimStart + s.start}:end=${trimStart + s.end},setpts=PTS-STARTPTS,setsar=1[tv${i}]`,
            `[0:a:0]atrim=start=${trimStart + s.start}:end=${trimStart + s.end},asetpts=PTS-STARTPTS[ta${i}]`));
        // Joint A/V concat pads each audio section to the last video frame, accumulating dialogue drift.
        graph.push(`${plan.timeline.keep.map((_, i) => `[tv${i}]`).join('')}concat=n=${plan.timeline.keep.length}:v=1:a=0[cv0]`,
            `${plan.timeline.keep.map((_, i) => `[ta${i}]`).join('')}concat=n=${plan.timeline.keep.length}:v=0:a=1[ca0]`);
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
    const overlays = stickerPath ? `ass='${escapePath(stickerPath)}',` : '';
    graph.push(`[${video}]${overlays}subtitles='${escapePath(subtitlePath)}'[vout]`);
    const sounds = plan.effects.map((row, index) => ({ row, index })).filter(({ row }) => row.sound);
    sounds.forEach(({ row, index }, soundIndex) => {
        const asset = bindings[`${index}:sound`], sound = SOUNDS[soundId(row.sound)];
        const offset = row.sound.offsetSeconds ?? 0;
        const duration = Math.min(asset ? asset.asset.sampleSeconds : sound.duration, plan.duration - row.start - offset);
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

module.exports = { STICKERS, SOUNDS, FILTERS, creativeSettings, speechForCreative, validateMoments, validateCreativePlan, assertRenderPlan, stickerAss, buildCreativeFilter };
