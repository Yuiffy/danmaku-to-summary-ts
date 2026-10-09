/** Prefer directly stated quantities for quantity questions; scores only recall, never establish a fact. */
export function evidenceScorer(terms: string[], question = ''): (text: string) => number {
  // Overlapping variants (奶茶 / 喝奶茶 / 奶茶数量) are one concept, not three independent matches.
  const concepts = terms.filter(term => !terms.some(other => other !== term && term.includes(other)));
  const unit = /(?:多少|几)\s*(杯|次|个|件|首|本|场|小时|分钟|天|元)/u.exec(question)?.[1] ||
    /(杯|次|个|件|首|本|场)数/u.exec(question)?.[1];
  const quantity = unit ? new RegExp(`(?:[0-9]+(?:\\.[0-9]+)?|[零一二两三四五六七八九十百千万]+)(?:多|余|来)?\\s*${unit}`, 'u') : undefined;
  const annual = /\d{4}年|今年|去年|全年|年度/u.test(question);
  return raw => {
    const text = raw.toLowerCase(), matched = concepts.filter(term => text.includes(term)).length;
    if (!matched) return 0;
    return matched + (quantity?.test(text) ? 3 + (annual && /今年|去年|前年|全年|一年|年度|年终|\d{4}年/u.test(text) ? 2 : 0) : 0);
  };
}
