type Data = Record<string, any>;

/** An operator may request a narrower draft without asserting a complete performance. */
export function selectSongExcerpt(event: Data, edit: Data): Data {
  if (!event || event.kind !== 'song' || event.id !== edit.activityId || event.verification?.decision !== 'uncertain'
    || !String(edit.note || '').trim() || ![edit.start, edit.end].every(Number.isFinite)
    || edit.start < event.start || edit.end > event.end || edit.end <= edit.start
    || edit.start === event.start && edit.end === event.end) {
    throw new Error('Song excerpt requires a narrower unresolved song and explicit operator feedback');
  }
  return { ...event, start: edit.start, end: edit.end, performance: 'fragment', startObserved: false, endObserved: false,
    provisionalWindow: { start: edit.start, end: edit.end },
    operatorBoundaryEdit: { version: 1, method: 'operator_selected_excerpt', note: edit.note,
      sourceWindow: { start: event.start, end: event.end }, selectedWindow: { start: edit.start, end: edit.end },
      audioVisualReviewed: false, automaticBoundaryApproved: false },
    verification: { ...event.verification, decision: 'uncertain', reason: edit.note },
    reviewIssues: [...new Set([...(event.reviewIssues || []), 'media_verification_unconfirmed',
      'performance_boundary_provisional', 'operator_selected_excerpt_pending_review'])] };
}
