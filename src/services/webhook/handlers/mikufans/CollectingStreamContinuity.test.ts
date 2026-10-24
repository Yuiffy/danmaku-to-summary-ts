import { LiveSession } from '../../LiveSessionManager';
import { CollectingStreamContinuity } from './CollectingStreamContinuity';

function fixture(status: LiveSession['status'] = 'collecting'): LiveSession {
  return { roomId: '1', roomName: 'room', title: 'stream', status, startTime: new Date(1000),
    segments: [{ videoPath: 'a', xmlPath: 'b', fileOpenTime: new Date(1000), fileCloseTime: new Date(100000), eventTimestamp: new Date(100000) }] };
}
test('preserves only an unprocessed recent collection and drops the floor after a longer break', () => {
  const policy = new CollectingStreamContinuity(), session = fixture();
  policy.observeResume(session, { startTime: new Date(1000), endTime: new Date(99000) }, new Date(134000));
  expect(policy.startFloor(session, 134000)).toBe(1000);
  expect(policy.startFloor(fixture(), 134000)).toBe(134000);
  session.status = 'completed';
  expect(policy.startFloor(session, 134000)).toBe(134000);
  session.status = 'collecting';
  policy.observeResume(session, { startTime: new Date(134000), endTime: new Date(135000) }, new Date(500000));
  expect(policy.startFloor(session, 500000)).toBe(500000);
});
test.each(['merging', 'processing', 'completed'] as const)('never resumes %s sources by timestamp alone', status => {
  const policy = new CollectingStreamContinuity(), session = fixture(status);
  policy.observeResume(session, { startTime: new Date(1000), endTime: new Date(99000) }, new Date(134000));
  session.status = 'collecting';
  expect(policy.startFloor(session, 134000)).toBe(134000);
});
test('rejects previous-session segments and missing observed end', () => {
  const policy = new CollectingStreamContinuity(), session = fixture();
  policy.observeResume(session, { startTime: new Date(120000), endTime: new Date(130000) }, new Date(134000));
  expect(policy.startFloor(session, 134000)).toBe(134000);
  policy.observeResume(session, { startTime: new Date(1000) }, new Date(134000));
  expect(policy.startFloor(session, 134000)).toBe(134000);
});
