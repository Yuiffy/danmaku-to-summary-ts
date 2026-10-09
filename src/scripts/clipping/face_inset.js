'use strict';
const finite = (n, lo, hi) => typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi;
const even = n => Math.round(n / 2) * 2;

function validateFaceInset(value) {
    const box = value?.sourceBox;
    const anchored = value?.placement === 'source';
    const retain = value?.mode === 'retain';
    const overflow = anchored && (value?.edgeOverflow === true || retain);
    if (!box || !finite(box.x, 0, 1) || !finite(box.y, 0, 1) || !finite(box.width, .025, .3)
        || !finite(box.height, .025, .4) || box.x + box.width > 1 || box.y + box.height > 1
        || (!anchored && (!finite(value.x, .02, .85) || !finite(value.y, .02, .6) || value.y + value.diameter > .84))
        || (retain && !anchored) || (!retain && !finite(value.diameter, .28, overflow ? .72 : .46))
        || (value.mode !== undefined && !['retain', 'enlarge'].includes(value.mode))
        || value.clearOfAction !== true) throw new Error('Invalid circular face inset or safe area');
    return { sourceBox: { ...box }, ...(anchored ? { placement: 'source' } : { x: value.x, y: value.y }), diameter: value.diameter,
        ...(overflow ? { edgeOverflow: true } : {}), ...(retain ? { mode: 'retain' } : {}), clearOfAction: true };
}

function insetGeometry(value, width, height) {
    const inset = validateFaceInset(value), box = inset.sourceBox;
    const anchored = inset.placement === 'source';
    const overflow = inset.edgeOverflow === true, retain = inset.mode === 'retain';
    // A square in source pixels (not normalized coordinates) preserves facial proportions.
    const side = even(Math.max(box.width * width, box.height * height) * 1.55);
    const size = retain ? side : even(Math.min(height * inset.diameter, anchored ? width * .5 : width, overflow ? side * 4.5 : Infinity));
    const margin = even(Math.min(width, height) * .005);
    let left = anchored ? even(Math.max(margin, Math.min(width - size - margin, (box.x + box.width / 2) * width - size / 2))) : even(width * inset.x);
    let top = anchored ? even(Math.max(margin, Math.min(height - size - margin, (box.y + box.height / 2) * height - size / 2))) : even(height * inset.y);
    if (!retain && (size / side < 1.2 || size / side > 4.51)) throw new Error('Face inset must magnify the complete face by 1.2–4.5x; tighten an oversized sourceBox around the actual face, not the hat/body');
    const x = even((box.x + box.width / 2) * width - side / 2), y = even((box.y + box.height / 2) * height - side / 2);
    const cropX = Math.max(0, x), cropY = Math.max(0, y), cropW = Math.min(width, x + side) - cropX, cropH = Math.min(height, y + side) - cropY;
    const padX = cropX - x, padY = cropY - y;
    if (overflow) {
        const scale = size / side;
        const origin = (limit, center, cropOrigin, pad, cropLength, bStart, bLength) => {
            const faceStart = (bStart - cropOrigin + pad) * scale, faceEnd = faceStart + bLength * scale;
            const startMargin = bStart >= 2 ? 2 : 0, endMargin = bStart + bLength <= limit - 2 ? 2 : 0;
            let lo = -faceStart + startMargin, hi = limit - faceEnd - endMargin;
            // Synthetic padding belongs outside the canvas, never inside the visible circle.
            if (pad) hi = Math.min(hi, -pad * scale);
            if (pad + cropLength < side) lo = Math.max(lo, limit - (pad + cropLength) * scale);
            lo = Math.ceil(lo / 2) * 2; hi = Math.floor(hi / 2) * 2;
            if (lo > hi) throw new Error('Face cannot remain fully visible without exposing source padding');
            return Math.max(lo, Math.min(hi, even(center - size / 2)));
        };
        left = origin(width, (box.x + box.width / 2) * width, cropX, padX, cropW, box.x * width, box.width * width);
        top = origin(height, (box.y + box.height / 2) * height, cropY, padY, cropH, box.y * height, box.height * height);
    } else if (left + size > width * (anchored ? 1 : .99) || top + size > height * (anchored ? 1 : .85)) throw new Error('Circular inset exceeds video safe area');
    return { size, left, top, side, cropX, cropY, cropW, cropH, padX, padY };
}

function faceInsetFilters(input, row, index, width, height, filter, sourceInput = null) {
    const g = insetGeometry(row.faceInset, width, height), radius = (g.size - 1) / 2;
    const gate = `gte(t,${row.start})*lt(t,${row.end})`;
    const lines = [...(sourceInput ? [] : [`[${input}]split=2[ib${index}][is${index}]`]),
        `[${sourceInput || `is${index}`}]trim=start=${row.start}:end=${row.end},crop=${g.cropW}:${g.cropH}:${g.cropX}:${g.cropY},`
            + `pad=${g.side}:${g.side}:${g.padX}:${g.padY}:color=0x16161b,scale=${g.size}:${g.size},setsar=1`
            + (filter ? `,${filter}` : '') + `[if${index}]`,
        `color=c=white:s=${g.size}x${g.size}:r=30,format=gray,geq=lum='255*clip((${radius}-hypot(X-${radius},Y-${radius}))/1.5,0,1)',`
            + `trim=end_frame=1,loop=loop=-1:size=1:start=0,setpts=N/(30*TB),trim=duration=${row.end - row.start},setpts=PTS+${row.start}/TB[im${index}]`,
        `[if${index}][im${index}]alphamerge[ic${index}]`,
        `[${sourceInput ? input : `ib${index}`}][ic${index}]overlay=${g.left}:${g.top}:enable='${gate}':eof_action=pass:repeatlast=0[iv${index}]`];
    return { lines, output: `iv${index}` };
}

function insetBorderDrawing(inset, width, height) {
    const g = insetGeometry(inset, width, height), r = g.size / 2, k = r * .55228475, d = g.size;
    const n = x => Number(x.toFixed(2));
    return { x: g.left, y: g.top, border: Math.max(2, Math.round(height * .003)),
        path: `m ${r} 0 b ${n(r + k)} 0 ${d} ${n(r - k)} ${d} ${r} b ${d} ${n(r + k)} ${n(r + k)} ${d} ${r} ${d} b ${n(r - k)} ${d} 0 ${n(r + k)} 0 ${r} b 0 ${n(r - k)} ${n(r - k)} 0 ${r} 0` };
}

function applyInsetLayout(raw, layout, requiredIds = null) {
    const targets = raw.effects.filter(row => row.zoom?.target === 'avatar' && (!requiredIds || requiredIds.includes(row.momentId)));
    const required = targets.map(row => row.momentId), supplied = layout?.insets?.map(row => row.momentId);
    if (!Array.isArray(supplied)) throw new Error(`Inset layout must cover every avatar reaction exactly once: required ${required.join(',')}`);
    const missing = required.filter(id => !supplied.includes(id)), extra = supplied.filter(id => !required.includes(id));
    const duplicates = supplied.filter((id, i) => supplied.indexOf(id) !== i);
    if (missing.length || extra.length || duplicates.length) throw new Error(`Inset layout must cover every avatar reaction exactly once: missing=${missing.join(',')}; unexpected=${extra.join(',')}; duplicate=${duplicates.join(',')}`);
    return { ...raw, effects: raw.effects.map(row => {
        const inset = layout.insets.find(item => item.momentId === row.momentId);
        return inset ? { ...row, zoom: null, faceInset: validateFaceInset(inset), reason: `${row.reason}；保留游戏全景，以圆形窗强调表情` } : row;
    }) };
}
function zoomHidesFace(zoom, sourceBox) {
    const extent = 1 / zoom.scale, x = Math.max(0, Math.min(1 - extent, zoom.x - extent / 2)), y = Math.max(0, Math.min(1 - extent, zoom.y - extent / 2));
    return sourceBox.x < x || sourceBox.y < y || sourceBox.x + sourceBox.width > x + extent || sourceBox.y + sourceBox.height > y + extent;
}

function avoidPartialFaceInDetail(zoom, face) {
    const b = zoom.targetBox;
    if (!b) return zoom;
    const extent = 1 / zoom.scale, left = Math.max(0, Math.min(1 - extent, zoom.x - extent / 2)), top = Math.max(0, Math.min(1 - extent, zoom.y - extent / 2));
    const intersects = (x, y) => x < face.x + face.width && x + extent > face.x && y < face.y + face.height && y + extent > face.y;
    if (!intersects(left, top)) return zoom;
    const options = [
        [face.x - extent - .008, top], [face.x + face.width + .008, top],
        [left, face.y - extent - .008], [left, face.y + face.height + .008]
    ].filter(([x, y]) => x >= 0 && y >= 0 && x + extent <= 1 && y + extent <= 1 && !intersects(x, y)
        && b.x >= x && b.y >= y && b.x + b.width <= x + extent && b.y + b.height <= y + extent)
        .sort((a, c) => Math.hypot(a[0] - left, a[1] - top) - Math.hypot(c[0] - left, c[1] - top));
    if (!options.length) return zoom;
    const [x, y] = options[0];
    return { ...zoom, x: x + extent / 2, y: y + extent / 2 };
}

function applyFaceRetention(raw, response, resolution) {
    const targets = raw.effects.filter(row => row.zoom?.target === 'detail' && !row.faceInset), ids = targets.map(row => row.momentId);
    if (!Array.isArray(response?.faces) || response.faces.length !== ids.length || new Set(response.faces.map(row => row.momentId)).size !== ids.length
        || response.faces.some(row => !ids.includes(row.momentId))) throw new Error(`Retained face observations must cover exactly: ${ids.join(',')}`);
    return { ...raw, effects: raw.effects.map(row => {
        const observation = response.faces.find(face => face.momentId === row.momentId);
        if (!observation || observation.sourceBox === null) return row;
        const faceInset = validateFaceInset({ sourceBox: observation.sourceBox, mode: 'retain', placement: 'source', edgeOverflow: true,
            clearOfAction: observation.clearOfAction });
        if (!zoomHidesFace(row.zoom, faceInset.sourceBox)) return row;
        insetGeometry(faceInset, resolution.width, resolution.height);
        return { ...row, zoom: avoidPartialFaceInDetail(row.zoom, faceInset.sourceBox), faceInset };
    }) };
}

module.exports = { validateFaceInset, insetGeometry, faceInsetFilters, insetBorderDrawing, applyInsetLayout, zoomHidesFace, applyFaceRetention, avoidPartialFaceInDetail };
