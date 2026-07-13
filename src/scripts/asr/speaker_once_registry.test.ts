const fs = require('fs');
const os = require('os');
const path = require('path');

const { SpeakerOnceRegistry } = require('./speaker_once_registry');
const { resolveRoom } = require('./speaker_once_cli');

describe('speaker_once_registry', () => {
  let tempDir: string;
  let registry: any;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-speaker-once-'));
    registry = new SpeakerOnceRegistry(path.join(tempDir, 'state.json'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('arms and consumes a room request exactly once', () => {
    const armed = registry.arm('25788785', {
      roomName: '岁己SUI',
      requestedBy: 'openclaw',
      expiresHours: 1
    });

    expect(registry.list()).toHaveLength(1);
    expect(registry.consume('25788785', { taskId: 'task-1', mediaPath: 'live.flv' })).toMatchObject({
      id: armed.id,
      roomId: '25788785',
      status: 'consumed',
      taskId: 'task-1'
    });
    expect(registry.consume('25788785', { taskId: 'task-2' })).toBeNull();
    expect(registry.list()).toEqual([]);
  });

  test('cancels an armed request', () => {
    registry.arm('26966466', { roomName: '栞栞', expiresHours: 1 });
    expect(registry.cancel('26966466')).toMatchObject({ roomId: '26966466' });
    expect(registry.list()).toEqual([]);
  });

  test('drops expired requests before consumption', () => {
    registry.arm('23260993', { expiresHours: 0.000001 });
    const state = JSON.parse(fs.readFileSync(path.join(tempDir, 'state.json'), 'utf8'));
    state.requests['23260993'].expiresAt = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(path.join(tempDir, 'state.json'), JSON.stringify(state), 'utf8');
    expect(registry.consume('23260993', { taskId: 'late' })).toBeNull();
  });

  test('resolves a configured streamer name to room id', () => {
    const config = {
      ai: {
        streamerRegistry: {
          shiori: {
            displayName: '栞栞',
            roomIds: ['26966466'],
            mentionLabels: ['小栞']
          }
        }
      }
    };
    expect(resolveRoom('小栞', config)).toMatchObject({ roomId: '26966466', roomName: '栞栞' });
    expect(resolveRoom('123', config)).toMatchObject({ roomId: '123' });
  });
});
