const fs = require('fs');
const os = require('os');
const path = require('path');
const comicGenerator = require('./ai_comic_generator');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

describe('ai_comic_generator Python wrapper', () => {
  test.each([false, true])('registers the source reader and stops it on registration failure: %s', async failRegistration => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'comic-reader-wrapper-'));
    const highlight = path.join(directory, 'recording_AI_HIGHLIGHT.txt');
    const source = path.join(directory, 'retained.flv');
    fs.writeFileSync(highlight, 'source facts');
    fs.writeFileSync(source, 'video bytes');
    const child: any = new EventEmitter();
    child.pid = 12345;
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = jest.fn(() => { child.killed = true; return true; });
    const spawn = jest.fn(() => {
      setImmediate(() => {
        child.emit('spawn');
        if (!child.killed) child.stdout.write(`输出文件: ${path.join(directory, 'image.png')}\n`);
        child.emit('close', child.killed ? 1 : 0);
      });
      return child;
    });
    const tmpdir = jest.spyOn(os, 'tmpdir').mockReturnValue(directory);
    const started = jest.fn(() => { if (failRegistration) throw new Error('cannot persist reader'); });
    jest.doMock('child_process', () => ({ ...jest.requireActual('child_process'), spawn }));
    jest.doMock('./config-loader', () => ({ getConfig: () => ({ ai: { comic: { concurrency: { maxConcurrentGenerations: 1 } } } }) }));
    let isolated;
    try {
      jest.isolateModules(() => { isolated = require('./ai_comic_generator'); });
      const result = await isolated.generateComicFromHighlight(highlight, '1', { sourceVideoPath: source, onProcessStarted: started });
      expect(started).toHaveBeenCalledWith(12345);
      expect(spawn.mock.calls[0][2].env.SOURCE_VIDEO_PATH).toBe(path.resolve(source));
      expect(result).toBe(failRegistration ? null : path.join(directory, 'image.png'));
      expect(child.kill).toHaveBeenCalledTimes(failRegistration ? 1 : 0);
      expect(fs.readdirSync(path.join(directory, 'danmaku-to-summary-comic-slots'))).toEqual([]);
      expect(fs.existsSync(source)).toBe(true);
    } finally {
      jest.dontMock('child_process'); jest.dontMock('./config-loader');
      tmpdir.mockRestore(); fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('derives and resolves the full-live-context sidecar path', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comic-full-context-'));
    try {
      const highlightPath = path.join(tempDir, '录制-26966466-test_AI_HIGHLIGHT.txt');
      const expectedPath = path.join(tempDir, '录制-26966466-test_FULL_LIVE_CONTEXT.json');

      expect(comicGenerator.getFullLiveContextPath(highlightPath)).toBe(expectedPath);
      expect(comicGenerator.resolveFullLiveContextPath(highlightPath)).toBeNull();

      fs.writeFileSync(expectedPath, '{"schemaVersion":1}', 'utf8');
      expect(comicGenerator.resolveFullLiveContextPath(highlightPath)).toBe(expectedPath);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
