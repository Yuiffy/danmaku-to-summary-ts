interface Speech { id: string; start: number; text: string }
interface Comment { id: string; time: number; text: string }

const evenly = <T>(rows: T[], count: number): T[] => count <= 0 ? [] : rows.length <= count ? rows
  : Array.from({ length: count }, (_, index) => rows[Math.floor(index * rows.length / count)]);

/** Keep distinct conversational wording before filling context slots with repeated reactions. */
export function sampleConversationComments(rows: Comment[], count: number): Comment[] {
  const unique = new Map<string, Comment>();
  for (const row of rows) {
    const words = row.text.normalize('NFKC').toLowerCase().replace(/\[[^\]\r\n]*\]/gu, '')
      .replace(/[^\p{L}\p{N}]/gu, '');
    if (Array.from(words).length < 4 || new Set(words).size < 3) continue;
    if (!unique.has(words)) unique.set(words, row);
  }
  const chosen = new Set(evenly([...unique.values()], count).map(row => row.id));
  evenly(rows.filter(row => !chosen.has(row.id)), count - chosen.size).forEach(row => chosen.add(row.id));
  return rows.filter(row => chosen.has(row.id));
}

/** Adjacent reading context only: these comments are not automatically questions answered by this cue. */
export function interleaveAudienceContext<T extends Speech>(speech: T[], audience: Comment[]): T[] {
  const comments = [...audience].sort((a, b) => a.time - b.time);
  let index = 0;
  return speech.map(cue => {
    const before: Comment[] = [];
    while (index < comments.length && comments[index].time <= cue.start) before.push(comments[index++]);
    return before.length ? { audienceBefore: before, ...cue } : { ...cue };
  });
}
