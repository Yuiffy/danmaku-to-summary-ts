import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import * as vm from 'vm';

const scriptPath = path.join(__dirname, 'enhanced_auto_summary.js');
const source = ts.createSourceFile(scriptPath, fs.readFileSync(scriptPath, 'utf8'), ts.ScriptTarget.Latest, true);
const settingsFunction = source.statements.find(node =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'shouldGenerateAiForRoom'
)!;
let comicBranch: ts.IfStatement;
function findComicBranch(node: ts.Node): void {
  if (ts.isIfStatement(node) && node.expression.getText(source) === 'aiSettings.comic') comicBranch = node;
  ts.forEachChild(node, findComicBranch);
}
findComicBranch(source);

function settingsFor(config: unknown, roomId = 'room') {
  return vm.runInNewContext(`${settingsFunction.getText(source)}; shouldGenerateAiForRoom(roomId)`, {
    roomId, configLoader: { getConfig: () => config }
  });
}

describe('automatic comic generation probability policy', () => {
  async function runComic(roomConfig: Record<string, unknown>, options: {
    durationMinutes?: number; defaultProbability?: number; roll?: number;
  } = {}) {
    const { durationMinutes, defaultProbability = 1, roll = 0.99 } = options;
    const config = { ai: { comic: { defaults: { generationProbability: defaultProbability, minDurationMinutes: 0 } }, roomSettings: { room: roomConfig } } };
    const events: string[] = [];
    const random = jest.fn().mockReturnValue(roll);
    const math = Object.create(Math);
    math.random = random;
    const generateAiComic = jest.fn(async () => { events.push('generate'); return 'image.png'; });
    const emitDelayedReplyReady = jest.fn(() => events.push('ready'));
    const configLoader = { getConfig: () => config };
    const settings = settingsFor(config);
    // Execute the actual CLI branch without importing its auto-running main or starting providers.
    const result = await vm.runInNewContext(`(async () => {
      let comicImagePath = null;
      ${comicBranch.getText(source)}
      return comicImagePath;
    })()`, {
      aiSettings: settings, Math: math, console: { log: jest.fn(), warn: jest.fn() },
      srtFile: durationMinutes === undefined ? null : 'fixture.srt',
      fs: { existsSync: () => true, readFileSync: () => `00:00:00,000 --> 00:${String(durationMinutes).padStart(2, '0')}:00,000` },
      path, __dirname, expectedComicImagePath: 'image.png', emitDelayedReplyReady,
      finalRoomId: 'room', mediaFiles: [], highlightPath: 'highlight.txt', highlightFile: 'highlight.txt',
      isAudioFile: () => false, configLoader, pendingBackgroundClipPayloads: [],
      automaticComicOptions: () => ({}), resolveComicSourceVideo: () => null,
      startBackgroundClipsOnce: jest.fn(), waitForLiveContentCacheWarmup: async () => undefined,
      liveContentSummaryPromise: null, liveContentSummaryEnabled: false, preparedFullLiveContext: null,
      liveContentSummary: { isExperimentTaskEnabled: () => false }, generateAiComic,
      runComicWithConcurrentClips: async options => {
        await options.prepareComic();
        return options.generateComic({});
      }
    });
    return { result, generateAiComic, emitDelayedReplyReady, events, random };
  }

  test.each([undefined, 1])('does not skip with a full default or room override: %s', async probability => {
    const result = await runComic({ enableComicGeneration: true, comicGenerationProbability: probability });
    expect(result.result).toBe('image.png');
    expect(result.generateAiComic).toHaveBeenCalledTimes(1);
    expect(result.emitDelayedReplyReady).toHaveBeenCalledWith('image.png');
    expect(result.events).toEqual(['ready', 'generate']);
    expect(result.random).toHaveBeenCalledTimes(1);
  });

  test.each([0, 0.8])('retains deliberate room-level sampling for future use: %s', async probability => {
    const result = await runComic({ enableComicGeneration: true, comicGenerationProbability: probability });
    expect(result.result).toBeNull();
    expect(result.generateAiComic).not.toHaveBeenCalled();
    expect(result.emitDelayedReplyReady).not.toHaveBeenCalled();
  });

  test('retains configurable global sampling and room override precedence', async () => {
    const inherited = await runComic({}, { defaultProbability: 0.8 });
    const overridden = await runComic({ comicGenerationProbability: 1 }, { defaultProbability: 0.8 });
    const sampled = await runComic({}, { defaultProbability: 0.8, roll: 0.5 });
    expect(inherited.result).toBeNull();
    expect(overridden.result).toBe('image.png');
    expect(sampled.result).toBe('image.png');
  });

  test('preserves an explicitly disabled room', async () => {
    const result = await runComic({ enableComicGeneration: false });
    expect(result.generateAiComic).not.toHaveBeenCalled();
    expect(result.emitDelayedReplyReady).not.toHaveBeenCalled();
  });

  test('preserves an explicit minimum duration without adding random skips', async () => {
    const result = await runComic({ enableComicGeneration: true, minComicDurationMinutes: 60 }, { durationMinutes: 30 });
    expect(result.generateAiComic).not.toHaveBeenCalled();
    expect(result.emitDelayedReplyReady).not.toHaveBeenCalled();
  });

  test('all enabled production rooms have full generation and no duration threshold', () => {
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../../config/production.json'), 'utf8'));
    const enabled = Object.keys(config.ai.roomSettings).map(roomId => settingsFor(config, roomId))
      .filter(room => room.comic);
    expect(enabled.length).toBeGreaterThan(0);
    for (const room of enabled) {
      expect(room.comicGenerationProbability).toBe(1);
      expect(room.minComicDurationMinutes).toBe(0);
    }
  });
});
