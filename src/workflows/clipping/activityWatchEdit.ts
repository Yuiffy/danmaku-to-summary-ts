type Data = Record<string, any>;

/** Apply an explicit operator boundary repair to a pending viewing candidate. */
export function selectWatchBoundary(event: Data, edit: Data): Data {
  if (!event || event.kind !== 'watch' || event.id !== edit.activityId
    || !String(edit.note || '').trim() || ![edit.start, edit.end].every(Number.isFinite)
    || edit.start < 0 || edit.end <= edit.start
    || edit.start > event.start || edit.end < event.end
    || event.start - edit.start > 180 || edit.end - event.end > 900
    || edit.start === event.start && edit.end === event.end) {
    throw new Error('Watch boundary edit requires an explicit bounded expansion of a pending viewing session');
  }
  const name = String(edit.name || event.name || '').trim() || null;
  const publicName = String(edit.publicName || event.publicName || '').trim() || null;
  const reviewIssues = (event.reviewIssues || []).filter((issue: string) =>
    !['media_verification_unconfirmed', 'watch_boundary_provisional', 'start_boundary_unconfirmed', 'end_boundary_unconfirmed'].includes(issue));
  return { ...event, start: edit.start, end: edit.end, ...(name ? { name } : {}), ...(publicName ? { publicName } : {}),
    startObserved: true, endObserved: true,
    operatorBoundaryEdit: { version: 1, method: 'operator_selected_boundary', note: edit.note,
      sourceWindow: { start: event.start, end: event.end }, selectedWindow: { start: edit.start, end: edit.end },
      audioVisualReviewed: true, automaticBoundaryApproved: false },
    verification: { ...event.verification, decision: 'keep', reason: edit.note,
      operatorBoundaryReview: { sourceWindow: { start: event.start, end: event.end }, selectedWindow: { start: edit.start, end: edit.end } } },
    reviewIssues: [...new Set([...reviewIssues, 'operator_boundary_edit_pending_human_review'])] };
}
