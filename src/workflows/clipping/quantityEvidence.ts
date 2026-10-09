type Span = { start: number; end: number };

const DIGITS = '零一二三四五六七八九';
const UNITS: Readonly<Record<string, number>> = { 十: 10, 百: 100, 千: 1000 };
const NUMERAL = '0-9零〇一二两三四五六七八九十百千';
// Unsupported larger, financial and decimal forms must not yield a smaller suffix.
const BOUNDARY = `${NUMERAL}万亿萬億兆点點几幾数數半壹贰叁肆伍陆柒捌玖拾佰仟负負.\\-`;
// Do not shorten compound words/units such as 元素、次方、个月 or 人次.
const QUANTITY = new RegExp(`(?<![${BOUNDARY}])([${NUMERAL}]+)\\s*(块钱|元(?!素|宵)|次(?!方)|个(?!月)|人(?!次)|岁)(?![${BOUNDARY}])`, 'gu');

function canonicalChineseInteger(value: number): string {
    if (value === 0) return '零';
    let result = '', zero = false;
    for (const [place, unit] of [[1000, '千'], [100, '百'], [10, '十'], [1, '']] as const) {
        const digit = Math.floor(value / place) % 10;
        if (!digit) {
            if (result) zero = true;
            continue;
        }
        if (zero) result += '零';
        if (!(place === 10 && digit === 1 && !result)) result += DIGITS[digit];
        result += unit;
        zero = false;
    }
    return result;
}

function integer(token: string): string | null {
    if (/^\d+$/u.test(token)) {
        const value = Number(token);
        return Number.isSafeInteger(value) ? String(value) : null;
    }
    // 两百/两千 are explicit; 两十 and digit-by-digit years are not cardinal quantities.
    if (token !== '两' && /两(?!百|千)/u.test(token)) return null;
    const normalized = token.replace(/〇/gu, '零').replace(/两/gu, '二');
    let total = 0, digit = 0;
    for (const char of normalized) {
        const value = DIGITS.indexOf(char);
        if (value >= 0) digit = value;
        else if (UNITS[char]) { total += (digit || 1) * UNITS[char]; digit = 0; }
        else return null;
    }
    total += digit;
    if (total > 9999) return null;
    // Requiring the complete standard form rejects 一百二, 二三十, missing zeros,
    // repeated units, and substrings of larger numbers instead of guessing intent.
    const explicitTen = normalized.replace(/^一十/u, '十');
    return canonicalChineseInteger(total) === explicitTen ? String(total) : null;
}

function quantities(text: string): Array<Span & { key: string }> {
    const results: Array<Span & { key: string }> = [];
    for (const match of text.matchAll(QUANTITY)) {
        // A spaced minus/negative prefix must not become evidence for a positive amount.
        if (/[负負-]\s*$/u.test(text.slice(0, match.index))) continue;
        const value = integer(match[1]);
        if (value === null) continue;
        const unit = match[2] === '块钱' ? '元' : match[2];
        results.push({ key: `${unit}:${value}`, start: match.index!, end: match.index! + match[0].length });
    }
    return results;
}

/** Only explicit whole quantities in each supplied evidence row can support copy. */
export function collectSpokenQuantityValues(sourceTexts: readonly string[]): Set<string> {
    return new Set(sourceTexts.flatMap(text => quantities(text).map(row => row.key)));
}

export function supportedQuantitySpans(copy: string, values: ReadonlySet<string>): Span[] {
    return quantities(copy).filter(row => values.has(row.key)).map(({ start, end }) => ({ start, end }));
}
