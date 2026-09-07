'use strict';

const DIGITS = new Map(Array.from('\u96f6\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d', (char, index) => [char, index]));
DIGITS.set('\u3007', 0);
DIGITS.set('\u4e24', 2);
const NUMERAL = '\\d\u96f6\u3007\u4e00\u4e8c\u4e24\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341';
const NUMBER_BOUNDARY = `${NUMERAL}\u767e\u5343\u4e07\u4ebf`;
const SPOKEN_CLOCK = new RegExp(
    `(?<![${NUMBER_BOUNDARY}])([${NUMERAL}]{1,3})\\s*(?:\u70b9|\u65f6)\\s*([${NUMERAL}]{1,3})\\s*\u5206`
    + `(?:\\s*([${NUMERAL}]{1,3})\\s*\u79d2)?(?![${NUMBER_BOUNDARY}]|\\s*[\u79d2\u949f])`, 'gu');
const DISPLAY_CLOCK = /(?<!\d)(?<!\d:)(\d{1,2}):(\d{2})(?::(\d{2}))?(?!\d|:\d|\.\d)/gu;

function component(value) {
    if (/^\d{1,2}$/u.test(value)) return Number(value);
    if (DIGITS.has(value)) return DIGITS.get(value);
    if (/^[\u96f6\u3007][\u96f6\u3007\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d]$/u.test(value)) return DIGITS.get(value[1]);
    const match = value.match(/^([\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d])?\u5341([\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d])?$/u);
    return match ? (match[1] ? DIGITS.get(match[1]) : 1) * 10 + (match[2] ? DIGITS.get(match[2]) : 0) : null;
}

function clockKey(hour, minute, second = null) {
    if (!Number.isInteger(hour) || hour < 0 || hour > 23
        || !Number.isInteger(minute) || minute < 0 || minute > 59
        || (second !== null && (!Number.isInteger(second) || second < 0 || second > 59))) return null;
    return `${hour}:${String(minute).padStart(2, '0')}${second === null ? '' : `:${String(second).padStart(2, '0')}`}`;
}

function collectSpokenClockValues(sourceTexts) {
    const values = new Set();
    for (const source of sourceTexts) {
        // Preserve numeric token boundaries and keep different evidence rows separate.
        const text = String(source || '');
        for (const match of text.matchAll(SPOKEN_CLOCK)) {
            const hour = component(match[1]), minute = component(match[2]);
            const second = match[3] === undefined ? null : component(match[3]);
            if (match[3] !== undefined && second === null) continue;
            const key = clockKey(hour, minute, second);
            if (key === null) continue;
            values.add(key);
            if (second !== null) values.add(clockKey(hour, minute));
        }
    }
    return values;
}

function supportedClockSpans(copy, values) {
    if (!values?.size) return [];
    const spans = [];
    for (const match of String(copy || '').matchAll(DISPLAY_CLOCK)) {
        const key = clockKey(Number(match[1]), Number(match[2]), match[3] === undefined ? null : Number(match[3]));
        if (key !== null && values.has(key)) spans.push({ start: match.index, end: match.index + match[0].length });
    }
    return spans;
}

module.exports = { collectSpokenClockValues, supportedClockSpans };
