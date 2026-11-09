'use strict';

function formatRelativeTimestamp(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

const DEFAULT_CUES = [{ pattern: /饼干岁/iu, text: '饼干岁吃太好了' }];

function buildTimelineCommentSuggestions({ cues = [], clipStart = 0, rules = DEFAULT_CUES } = {}) {
    const start = Number(clipStart) || 0;
    const seen = new Set();
    return (Array.isArray(cues) ? cues : []).flatMap(cue => {
        const text = String(cue?.text || '');
        const rule = rules.find(item => item.pattern.test(text));
        if (!rule) return [];
        const timestamp = formatRelativeTimestamp((Number(cue.start) || start) - start);
        const key = `${timestamp}|${rule.text}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [{ timestamp, content: rule.text, sourceCueId: cue.id || null }];
    });
}

module.exports = { formatRelativeTimestamp, buildTimelineCommentSuggestions, DEFAULT_CUES };
