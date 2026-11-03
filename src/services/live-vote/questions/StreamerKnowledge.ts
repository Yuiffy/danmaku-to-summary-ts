/** Maintained broadcaster facts confirmed by the operator; not inferred from audience messages. */
const KNOWLEDGE = [{
  roomId: '25788785', name: '岁己SUI', updatedOn: '2026-10-29', provenance: '用户明确确认的常识，非逐字录播引文',
  facts: [{ id: 'work-rest-cycle', text: '通常上五休一：连续直播5天后休息1天，每6天一轮，不是每周固定某个星期几休息。',
    workDays: 5, restDays: 1, cycleDays: 6,
    limits: '常规节奏可能因请假、加播或调休改变。推算具体日期须核对最近一次休息日或连续直播日期，优先采用较新的明确安排，并在长短答中标明预计/按惯例推算。' }]
}];

export function streamerKnowledge(roomIds: readonly string[]): string {
  const entries = KNOWLEDGE.filter(entry => roomIds.includes(entry.roomId));
  return entries.length ? `维护的主播常识（仅适用于对应房间；不是本周日程公告，也不能冒充主播原话）：${JSON.stringify(entries)}` : '';
}
