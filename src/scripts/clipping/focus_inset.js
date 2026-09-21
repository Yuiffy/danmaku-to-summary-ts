'use strict';
const face = require('./face_inset');
const even = n => Math.round(n / 2) * 2;
const finite = (n, lo, hi) => typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi;

function validateFocusInset(raw) {
    if (!['avatar', 'person', 'chat', 'detail'].includes(raw?.target) || !['circle', 'rectangle'].includes(raw?.shape)
        || raw.placement !== 'source' || raw.clearOfAction !== true) throw new Error('Focus inset needs a known subject, source placement and visual confirmation');
    if (raw.shape === 'circle') return { ...face.validateFaceInset(raw), target: raw.target, shape: raw.shape };
    const b = raw.sourceBox;
    if (!b || !finite(b.x, 0, 1) || !finite(b.y, 0, 1) || !finite(b.width, .025, .6) || !finite(b.height, .025, .6)
        || b.x + b.width > 1 || b.y + b.height > 1 || !finite(raw.magnification, 1.2, 3)) throw new Error('Invalid focus text/detail region');
    return { target: raw.target, shape: 'rectangle', placement: 'source', sourceBox: { ...b }, magnification: raw.magnification, clearOfAction: true };
}
function focusGeometry(raw, width, height) {
    const value = validateFocusInset(raw);
    if (value.shape === 'circle') { const g = face.insetGeometry(value, width, height); return { ...g, outputWidth: g.size, outputHeight: g.size, shape: 'circle' }; }
    const b = value.sourceBox, cropX = even(b.x * width), cropY = even(b.y * height);
    const cropW = even(Math.min(width - cropX, b.width * width)), cropH = even(Math.min(height - cropY, b.height * height));
    const scale = Math.min(value.magnification, width * .75 / cropW, height * .72 / cropH);
    if (scale < 1.2) throw new Error('Focus region is too large for a useful in-place enlargement');
    const outputWidth = even(cropW * scale), outputHeight = even(cropH * scale);
    const left = even(Math.max(4, Math.min(width - outputWidth - 4, cropX + cropW / 2 - outputWidth / 2)));
    const top = even(Math.max(4, Math.min(height - outputHeight - 4, cropY + cropH / 2 - outputHeight / 2)));
    return { shape: 'rectangle', left, top, outputWidth, outputHeight, cropX, cropY, cropW, cropH };
}
function focusInsetFilters(input, row, index, width, height, filter) {
    const value = row.focusInset;
    if (value.shape === 'circle') return face.faceInsetFilters(input, { ...row, faceInset: value }, index, width, height, filter);
    const g = focusGeometry(value, width, height);
    return { output: `iv${index}`, lines: [`[${input}]split=2[ib${index}][is${index}]`,
        `[is${index}]trim=start=${row.start}:end=${row.end},crop=${g.cropW}:${g.cropH}:${g.cropX}:${g.cropY},scale=${g.outputWidth}:${g.outputHeight},setsar=1${filter ? `,${filter}` : ''}[ic${index}]`,
        `[ib${index}][ic${index}]overlay=${g.left}:${g.top}:enable='gte(t,${row.start})*lt(t,${row.end})':eof_action=pass:repeatlast=0[iv${index}]`] };
}
function focusBorderDrawing(value, width, height) {
    if (value.shape === 'circle') return face.insetBorderDrawing(value, width, height);
    const g = focusGeometry(value, width, height), w = g.outputWidth, h = g.outputHeight;
    return { x: g.left, y: g.top, border: Math.max(2, Math.round(height * .003)), path: `m 0 0 l ${w} 0 ${w} ${h} 0 ${h} 0 0` };
}
module.exports = { validateFocusInset, focusGeometry, focusInsetFilters, focusBorderDrawing };
