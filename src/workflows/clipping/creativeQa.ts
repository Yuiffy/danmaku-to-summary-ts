type Data = Record<string, any>;

/** Keep explicit source anchors before serializing structured review defects. */
export function normalizeCreativeQa(value: Data): Data {
    if (!Array.isArray(value?.issues)) return value;
    const required = [...(Array.isArray(value.requiredSourceCueIds) ? value.requiredSourceCueIds : [])];
    const issues = value.issues.map((issue: unknown) => {
        let structured = issue;
        if (typeof issue === 'string' && issue.trim()) {
            try { structured = JSON.parse(issue); } catch { return issue; }
        }
        if (structured && typeof structured === 'object' && !Array.isArray(structured)) {
            const row = structured as Data;
            if (!['issue', 'message', 'description', 'reason', 'problem', 'detail', '问题']
                .some(key => typeof row[key] === 'string' && row[key].trim())) {
                if (typeof issue === 'string') return issue;
                throw new Error(`Invalid creative QA issue: ${JSON.stringify(issue)}`);
            }
            if (row.requiredSourceCueIds !== undefined) {
                if (!Array.isArray(row.requiredSourceCueIds)
                    || row.requiredSourceCueIds.some((id: unknown) => typeof id !== 'string' || !/^R[1-9]\d*$/u.test(id))) {
                    throw new Error('Invalid creative QA source cue IDs');
                }
                required.push(...row.requiredSourceCueIds);
            }
            return typeof issue === 'string' ? issue : JSON.stringify(issue);
        }
        if (typeof issue === 'string' && issue.trim()) return issue;
        throw new Error(`Invalid creative QA issue: ${JSON.stringify(issue)}`);
    });
    return { ...value, issues, ...(required.length ? { requiredSourceCueIds: [...new Set(required)] } : {}) };
}
