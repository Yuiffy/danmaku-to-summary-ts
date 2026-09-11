'use strict';

const DIGITS = new Map(Array.from('零一二三四五六七八九', (char, index) => [char, index]));
DIGITS.set('〇', 0);
const NUMERAL = '\\d零〇一二三四五六七八九十';
const BOUNDARY = `${NUMERAL}百千万亿两`;
const PART = `[${NUMERAL}]{1,4}`;
// Consume complete dates before checking their components; never borrow a month
// from another date or turn a date's digits into support for a price/count.
const DATE = new RegExp(`(?<![${BOUNDARY}])(?:(${PART})\\s*年(?:\\s*(${PART})\\s*月(?:\\s*(${PART})\\s*[日号])?)?`
    + `|(${PART})\\s*月(?:\\s*(${PART})\\s*[日号])?)(?![${BOUNDARY}])`, 'gu');

function component(value) {
    if (value === undefined) return null;
    if (/^\d{1,2}$/u.test(value)) return Number(value);
    if (DIGITS.has(value)) return DIGITS.get(value);
    const tens = value.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/u);
    return tens ? (tens[1] ? DIGITS.get(tens[1]) : 1) * 10 + (tens[2] ? DIGITS.get(tens[2]) : 0) : NaN;
}

function year(value, month, referenceYear) {
    if (value === undefined) return null;
    const digits = /^\d+$/u.test(value) ? value
        : Array.from(value, char => DIGITS.has(char) ? DIGITS.get(char) : '?').join('');
    if (/^\d{4}$/u.test(digits)) return Number(digits);
    // A spoken digit-by-digit year plus month can abbreviate a recent past year.
    // Anchor its century to the recording, never to the machine's current date.
    if (/^[零〇一二三四五六七八九]{2}$/u.test(value) && month !== null
        && Number.isInteger(referenceYear) && referenceYear >= 1000 && referenceYear <= 9999) {
        const result = Math.floor(referenceYear / 100) * 100 + Number(digits);
        return result > referenceYear ? result - 100 : result;
    }
    return NaN;
}

function dates(text, referenceYear) {
    const results = [];
    for (const match of String(text || '').matchAll(DATE)) {
        const month = component(match[2] ?? match[4]);
        const day = component(match[3] ?? match[5]);
        const fullYear = year(match[1], month, referenceYear);
        if (Number.isNaN(fullYear) || (fullYear !== null && fullYear < 1000)
            || (month !== null && (!Number.isInteger(month) || month < 1 || month > 12))
            || (day !== null && (!Number.isInteger(day) || day < 1 || day > 31))) continue;
        if (day !== null) {
            const maxDay = new Date(Date.UTC(fullYear ?? 2000, month, 0)).getUTCDate();
            if (day > maxDay) continue;
        }
        results.push({ year: fullYear, month, day, start: match.index, end: match.index + match[0].length });
    }
    return results;
}

function collectSpokenDates(sourceTexts, referenceYear) {
    return sourceTexts.flatMap(text => dates(text, referenceYear));
}

function supportedDateSpans(copy, sourceDates) {
    return dates(copy).filter(date => sourceDates.some(source =>
        ['year', 'month', 'day'].every(part => date[part] === null || date[part] === source[part])))
        .map(({ start, end }) => ({ start, end }));
}

module.exports = { collectSpokenDates, supportedDateSpans };
