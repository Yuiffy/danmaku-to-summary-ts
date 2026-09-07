export {};
const fs = require('fs');
const os = require('os');
const path = require('path');
const { enhancementEnabled, runEnhancements } = require('./enhancement_runner');

test('enhancements require both an explicit switch and a matching room', async () => {
    const metadata = { copy: { title: 'Existing' } };
    expect(enhancementEnabled({ enabled: true, roomIds: [] }, 'room')).toBe(false);
    expect(enhancementEnabled({ enabled: false, roomIds: ['room'] }, 'room')).toBe(false);
    expect(await runEnhancements(metadata, { config: {}, info: { roomId: 'room' } })).toBe(metadata);
});

test('global no-AI configuration cannot be bypassed by enhancement stages', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'enhancement-disabled-'));
    const metadata = { uploadReady: true, output: { metadataPath: path.join(directory, 'clip.json') } };
    try {
        const result = await runEnhancements(metadata, { config: { ai: { enabled: false }, enhancements: { enabled: true, roomIds: ['room'] } },
            info: { roomId: 'room' } });
        expect(result.uploadReady).toBe(false);
        expect(result.qaResult).toMatchObject({ status: 'failed', error: 'AI is disabled; required QA cannot run' });
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
