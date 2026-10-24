import { LIVE_RECONNECT_GRACE_MS, LiveSession } from '../../LiveSessionManager';

/** Keep the eligibility floor of a still-unprocessed collection across a brief reconnect. */
export class CollectingStreamContinuity {
  private readonly floors = new WeakMap<LiveSession, number>();

  observeResume(session: LiveSession | undefined, previous: { startTime?: Date; endTime?: Date } | undefined, start: Date): void {
    if (!session) return;
    const retained = this.floors.get(session);
    this.floors.delete(session);
    if (session.status !== 'collecting' || !previous?.startTime || !previous.endTime) return;
    const gap = start.getTime() - previous.endTime.getTime();
    const floor = retained ?? previous.startTime.getTime();
    const tail = Math.max(...session.segments.map(segment => segment.fileCloseTime.getTime()));
    if (gap > 0 && gap <= LIVE_RECONNECT_GRACE_MS && tail >= floor - 5000
        && tail <= start.getTime() + 5000 && start.getTime() - tail <= LIVE_RECONNECT_GRACE_MS) {
      this.floors.set(session, floor);
    }
  }

  startFloor(session: LiveSession, latestStart: number | undefined): number | undefined {
    return session.status === 'collecting' ? this.floors.get(session) ?? latestStart : latestStart;
  }
}
