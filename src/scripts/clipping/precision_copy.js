'use strict';
const { loadWorkflow } = require('../workflow-runtime');
const { soundId } = require('./creative_assets');
const { SOUNDS } = require('./creative_plan');

const LAUGHTER = new Set(['audience_laugh', 'sitcom_laugh', 'sitcom_laugh_chuckle', 'sitcom_laugh_warm', 'sitcom_laugh_applause']);
const FILTER_LABELS = { monochrome: '黑白滤镜', cold: '冷色滤镜', warm: '暖色滤镜', vignette: '暗角滤镜' };
const TARGET_LABELS = { avatar: '头像放大', person: '人物放大', chat: '文字/弹幕放大', detail: '画面细节放大' };
const round = value => Number(value.toFixed(2));
const clock = value => {
    const hundredths = Math.round(value * 100);
    return `${String(Math.floor(hundredths / 6000)).padStart(2, '0')}:${(hundredths % 6000 / 100).toFixed(2).padStart(5, '0')}`;
};

/** Use the final rendered plan and measured audio windows, never a model's discarded draft. */
function precisionDetail(metadata, assets = {}) {
    const plan = metadata.creativePlan;
    if (!plan || plan.workflow !== 'creative' || !Number.isFinite(plan.duration) || plan.duration <= 0 || !Array.isArray(plan.effects)) {
        throw new Error('Missing final creative plan for precision disclosure');
    }
    const sources = Object.fromEntries((metadata.enhancement?.assetSources || []).map(asset => [asset.id, asset]));
    const rows = [];
    const add = (start, end, label) => {
        if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= plan.duration || end <= start) {
            throw new Error('Invalid rendered effect timing for precision disclosure');
        }
        rows.push({ start, text: `${clock(start)}-${clock(Math.min(end, plan.duration))} ${label}` });
    };
    if (plan.music) add(0, plan.duration, '添加 BGM（背景音乐）');
    for (const effect of plan.effects) {
        const visual = [];
        if (effect.zoom) visual.push(TARGET_LABELS[effect.zoom.target] || '画面放大');
        if (effect.focusInset) visual.push(TARGET_LABELS[effect.focusInset.target] || '局部放大');
        if (effect.faceInset) visual.push(effect.faceInset.mode === 'retain' ? '原大小人脸保留窗' : '头像放大（圆窗）');
        if (effect.sticker) visual.push('后期贴图');
        if (effect.filter) visual.push(FILTER_LABELS[effect.filter] || '画面滤镜');
        if (visual.length) add(effect.start, effect.end, visual.join('、'));
        if (effect.sound) {
            const id = soundId(effect.sound), asset = assets[id] || sources[id];
            const start = effect.start + (effect.sound.offsetSeconds || 0);
            const measured = metadata.audioQa?.effects?.find(row => row.id === id && Math.abs(row.start - start) < .001);
            const end = measured?.end ?? start + (asset?.sampleSeconds ?? SOUNDS[id]?.duration);
            const laughter = asset?.family === 'laughter' || LAUGHTER.has(id);
            add(start, end, laughter ? '后期罐头笑声' : '后期提示音效');
        }
    }
    const lines = [loadWorkflow('clipping/experiment').PRECISION_DETAIL_MARKER,
        '以下时间为本视频进度；音乐、笑声、音效和贴图如有列出，均为后期添加。'];
    const removed = plan.timeline?.removedSeconds || 0;
    if (removed > 0) lines.push(`节奏剪辑：删减 ${round(removed)} 秒，成片 ${round(plan.duration)} 秒。`);
    lines.push(...rows.sort((a, b) => a.start - b.start).map(row => row.text));
    return lines.join('\n');
}

function labelCreativeCopy(copy, metadata, assets = {}) {
    const { labelExperimentTitle, labelExperimentDescription } = loadWorkflow('clipping/experiment');
    const description = labelExperimentDescription(copy.description, true,
        Boolean(metadata.editPlan?.removed?.length || metadata.creativePlan?.timeline?.removedSeconds), precisionDetail(metadata, assets));
    if (Array.from(description).length > 2000) throw new Error('Precision description exceeds the Bilibili 2000-character limit');
    return { ...copy, title: labelExperimentTitle(copy.title, true), description };
}

function publicationCopy(metadata, copy) {
    if (metadata.creativeResult?.status !== 'edited' || metadata.qaResult?.status !== 'passed'
        || (metadata.audioQa && metadata.audioQa.status !== 'passed')) throw new Error('Precision disclosure requires a passed rendered revision');
    return labelCreativeCopy(copy || metadata.copy, metadata);
}

module.exports = { precisionDetail, labelCreativeCopy, publicationCopy };
if (require.main === module) {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', () => {
        try {
            const { metadata, copy } = JSON.parse(input);
            process.stdout.write(JSON.stringify(publicationCopy(metadata, copy)));
        } catch (error) { process.stderr.write(error.message); process.exitCode = 1; }
    });
}
