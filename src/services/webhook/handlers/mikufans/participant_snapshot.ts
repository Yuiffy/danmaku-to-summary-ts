import * as path from 'path';
import { ConfigProvider } from '../../../../core/config/ConfigProvider';

/** Capture at stream start because queued ASR may run after the room cover changes. */
export function captureParticipantSnapshot(roomId: string, startTime: Date, previousStart: Date | undefined,
  logger: { info: (message: string, data: any) => void; warn: (message: string, data: any) => void }): void {
  if (previousStart?.getTime() === startTime.getTime()) return;
  try {
    const config = ConfigProvider.getConfig();
    if (config.asr?.participantDiscovery?.enabled !== true || config.asr.participantDiscovery.visual?.enabled !== true) return;
    const collector = require(path.join(process.cwd(), 'src', 'scripts', 'asr', 'participant_visual.js'));
    void collector.captureParticipantRoomSnapshot(config, { roomId, startedAt: startTime.toISOString() })
      .then((result: { status: string }) => logger.info('本场房间标题/封面快照', { roomId, status: result.status }))
      .catch((error: Error) => logger.warn('本场房间快照采集失败', { roomId, error: error.message }));
  } catch (error: any) {
    logger.warn('本场房间快照采集不可用', { roomId, error: error.message });
  }
}
