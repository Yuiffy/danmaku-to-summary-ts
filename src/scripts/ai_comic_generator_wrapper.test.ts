const fs = require('fs');
const os = require('os');
const path = require('path');
const comicGenerator = require('./ai_comic_generator');

describe('ai_comic_generator Python wrapper', () => {
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
