'use strict';
const fs = require('fs');
const { insetGeometry } = require('./face_inset');
const { focusGeometry } = require('./focus_inset');

function focusBounds(row, width, height) {
    if (row.focusInset) return focusGeometry(row.focusInset, width, height);
    if (row.faceInset) { const g = insetGeometry(row.faceInset, width, height); return { ...g, outputWidth: g.size, outputHeight: g.size }; }
    const b = row.sticker?.anchorBox;
    if (b && [b.x, b.y, b.width, b.height].every(Number.isFinite) && b.x >= 0 && b.y >= 0 && b.width > 0 && b.height > 0
        && b.x + b.width <= 1 && b.y + b.height <= 1) return { left: b.x * width, top: b.y * height, outputWidth: b.width * width, outputHeight: b.height * height };
    return null;
}

function groupSticker(sticker, box, width, height, assets) {
    if (!sticker || !box) return sticker;
    const png = assets[sticker.id]?.kind === 'sticker';
    const boundedWidth = png ? Math.max(.08, Math.min(sticker.width || .2, .14, box.outputWidth / width * .65)) : sticker.width;
    const w = png ? boundedWidth * width : height * .12, h = png ? height * .22 : height * .14;
    const gap = height * .025;
    const locations = [
        { side: 'above', x: box.left + box.outputWidth / 2, y: box.top - h / 2 - gap },
        { side: 'left', x: box.left - w / 2 - gap, y: Math.max(box.top + h / 2, height * .02 + h / 2) },
        { side: 'right', x: box.left + box.outputWidth + w / 2 + gap, y: Math.max(box.top + h / 2, height * .02 + h / 2) }
    ];
    const p = locations.find(p => p.x - w / 2 >= width * .02 && p.x + w / 2 <= width * .98
        && p.y - h / 2 >= height * .02 && p.y + h / 2 <= height * .82);
    if (!p) return null; // Do not move a reaction into an unrelated corner to make it fit.
    return { ...sticker, x: p.x / width, y: p.y / height, ...(png ? { width: boundedWidth, heightLimit: .22 } : {}),
        anchor: 'subject', anchorSide: p.side };
}


function checkedFaceGeometry(row, resolution) {
    try {
        return insetGeometry(row.faceInset, resolution.width, resolution.height);
    } catch (error) {
        const box = row.faceInset.sourceBox;
        const side = Math.round(Math.max(box.width * resolution.width, box.height * resolution.height) * 1.55 / 2) * 2;
        const diameter = row.faceInset.diameter;
        const size = diameter == null ? side : Math.round(Math.min(resolution.height * diameter,
            row.faceInset.placement === 'source' ? resolution.width * .5 : resolution.width,
            row.faceInset.edgeOverflow ? side * 4.5 : Infinity) / 2) * 2;
        throw new Error(`${row.id || row.momentId}: ${error.message} (effective diameter=${diameter ?? 'retain'}, magnification=${(size / side).toFixed(2)}x)`);
    }
}

function sourceFaceDiameter(inset, resolution, settings) {
    if (inset.mode === 'retain' || !settings.faceInsetDiameter) return inset.diameter;
    const side = Math.round(Math.max(inset.sourceBox.width * resolution.width,
        inset.sourceBox.height * resolution.height) * 1.55 / 2) * 2;
    // Keep the face visibly larger without turning a gameplay inset into a second canvas.
    const minimum = Math.ceil(side * 1.2 / 2) * 2 / resolution.height;
    return Math.min(settings.faceInsetDiameter, Math.max(inset.diameter ?? .28, minimum));
}

function anchorSpatialPlan(plan, resolution, settings, assets = {}) {
    if (settings.focusPlacement !== 'source') return plan;
    const { width, height } = resolution;
    const effects = plan.effects.map(row => {
        const next = { ...row };
        if (row.faceInset) next.faceInset = { ...row.faceInset, placement: 'source',
            ...(row.faceInset.mode === 'retain' || settings.faceInsetDiameter ? { edgeOverflow: true } : {}),
            ...(row.faceInset.mode !== 'retain' && settings.faceInsetDiameter
                ? { diameter: sourceFaceDiameter(row.faceInset, resolution, settings) } : {}) };
        if (row.focusInset) next.focusInset = { ...row.focusInset, placement: 'source',
            ...(row.focusInset.shape === 'circle' && ['avatar', 'person'].includes(row.focusInset.target) && settings.faceInsetDiameter
                ? { edgeOverflow: true, diameter: Math.max(row.focusInset.diameter, settings.faceInsetDiameter) } : {}) };
        const face = next.faceInset && row.sticker ? checkedFaceGeometry(next, resolution) : null;
        const bounds = face ? { ...face, outputWidth: face.size, outputHeight: face.size }
            : row.sticker ? focusBounds(next, width, height) : null;
        if (row.sticker && bounds) next.sticker = groupSticker(row.sticker, bounds, width, height, assets);
        return next;
    });
    return { ...plan, effects, spatialLayout: { version: 1, focusPlacement: 'source', stickers: 'near_subject', subtitles: 'avoid_focus' } };
}

function validateAnchoredFaceInsets(plan, resolution, settings) {
    const anchored = anchorSpatialPlan(plan, resolution, settings);
    for (const row of anchored.effects.filter(row => row.faceInset)) {
        checkedFaceGeometry(row, resolution);
    }
    return anchored;
}

function coverWindowWithoutInset(plan) {
    const windows = [...plan.effects].filter(row => row.faceInset || row.focusInset)
        .map(row => ({ start: row.start, end: row.end })).sort((a, b) => a.start - b.start);
    let cursor = Math.min(1, plan.duration), best = null;
    for (const window of [...windows, { start: plan.duration, end: plan.duration }]) {
        const start = cursor, end = Math.min(plan.duration, window.start);
        if (end - start >= 1.2 && (!best || end - start > best.end - best.start)) best = { start, end };
        cursor = Math.max(cursor, window.end);
    }
    return best;
}

function coverProtectedBoxes(plan) {
    const boxes = plan.effects.map(row => row.faceInset?.sourceBox)
        .filter(box => box && [box.x, box.y, box.width, box.height].every(Number.isFinite));
    // These are source-frame coordinates, including the avatar even outside an inset effect.
    return boxes.filter((box, index) => boxes.findIndex(other => JSON.stringify(other) === JSON.stringify(box)) === index);
}

function subtitleZone(row, width, height, marginV) {
    const box = focusBounds(row, width, height);
    if (!box || box.top + box.outputHeight < height * .76) return null;
    const margin = width * .04, gap = width * .02;
    const left = { left: margin, right: box.left - gap, bottom: height - marginV };
    const right = { left: box.left + box.outputWidth + gap, right: width - margin, bottom: height - marginV };
    const best = [left, right].sort((a, b) => (b.right - b.left) - (a.right - a.left))[0];
    if (best.right - best.left >= width * .40) return best;
    if (box.top >= height * .28) return { left: margin, right: width - margin, bottom: box.top - height * .025 };
    throw new Error('Focus leaves no readable subtitle area; reduce or omit the enlargement');
}

const seconds = value => { const [h, m, s] = value.split(':').map(Number); return h * 3600 + m * 60 + s; };
const clock = time => { const n = Math.round(time * 100); return `${Math.floor(n / 360000)}:${String(Math.floor(n / 6000) % 60).padStart(2, '0')}:${String(Math.floor(n / 100) % 60).padStart(2, '0')}.${String(n % 100).padStart(2, '0')}`; };

function reflowAssText(text, availableWidth, fontSize) {
    // Preserve escaped glyphs and wording; only display line breaks change.
    const tokens = text.match(/\\[Nnh{}\\]|./gu) || [];
    const glyphs = tokens.filter(t => t !== '\\N' && t !== '\\n');
    const weight = t => t === '\\h' ? .5 : /[\u0000-\u007f]/u.test(t.at(-1)) ? .55 : .96;
    const units = glyphs.reduce((sum, t) => sum + weight(t), 0), capacity = availableWidth / fontSize;
    const lines = Math.max(1, Math.ceil(units / capacity)), target = Math.min(capacity, units / lines + .6);
    const out = []; let line = '', length = 0;
    for (const token of glyphs) {
        const size = weight(token);
        if (line && length + size > target) { out.push(line); line = ''; length = 0; }
        line += token; length += size;
    }
    if (line) out.push(line);
    return out.join('\\N');
}

/** Keep the SRT immutable. Split ASS events only at layout boundaries and retain the original large font. */
function layoutSubtitleAss(content, plan, style) {
    if (!plan.spatialLayout || plan.spatialLayout.subtitles !== 'avoid_focus') return content;
    const width = style.playResX, height = style.playResY, marginV = style.marginV, fontSize = style.fontSize;
    const zones = plan.effects.map(row => ({ start: row.start, end: row.end, zone: subtitleZone(row, width, height, marginV) })).filter(row => row.zone);
    if (!zones.length) return content;
    return content.split(/\r?\n/).flatMap(line => {
        if (!line.startsWith('Dialogue: ')) return [line];
        const parts = line.slice(10).split(',');
        const fields = parts.slice(0, 9), text = parts.slice(9).join(',');
        const start = seconds(fields[1]), end = seconds(fields[2]);
        const overlaps = zones.filter(z => z.start < end && z.end > start);
        if (!overlaps.length) return [line];
        const cuts = [...new Set([start, end, ...overlaps.flatMap(z => [Math.max(start, z.start), Math.min(end, z.end)])])].sort((a, b) => a - b);
        return cuts.slice(0, -1).flatMap((a, i) => {
            const b = cuts[i + 1]; if (Math.round(b * 100) <= Math.round(a * 100)) return [];
            const zone = overlaps.find(z => (a + b) / 2 >= z.start && (a + b) / 2 < z.end)?.zone;
            const f = [...fields]; f[1] = clock(a); f[2] = clock(b);
            let caption = text;
            if (zone) {
                caption = reflowAssText(text, zone.right - zone.left - style.outline * 2, fontSize);
                const lineCount = caption.split('\\N').length;
                if (zone.bottom - lineCount * fontSize * 1.15 < 0) throw new Error('Subtitle text cannot fit the focus-aware layout');
                caption = `{\\an2\\q2\\pos(${Math.round((zone.left + zone.right) / 2)},${Math.round(zone.bottom)})}${caption}`;
            }
            return [`Dialogue: ${f.join(',')},${caption}`];
        });
    }).join('\n');
}

function writeLayoutSubtitles(file, plan, style) { fs.writeFileSync(file, layoutSubtitleAss(fs.readFileSync(file, 'utf8'), plan, style), 'utf8'); }
module.exports = { focusBounds, groupSticker, anchorSpatialPlan, validateAnchoredFaceInsets, coverWindowWithoutInset, coverProtectedBoxes, subtitleZone, reflowAssText, layoutSubtitleAss, writeLayoutSubtitles };
