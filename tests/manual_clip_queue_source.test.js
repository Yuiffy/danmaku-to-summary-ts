'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    buildQueueMediaConfig,
    buildUploadSource,
    formatRecordedAt,
    normalizeStreamTitle
} = require('../src/scripts/manual_clip_queue');

test('builds a concrete source from manual task metadata', () => {
    assert.equal(
        buildUploadSource({
            streamerName: '岁己SUI',
            streamTitle: '陪你这个猪过周日！_merged',
            recordedAt: '2026-08-16T20:05:09+08:00'
        }),
        '岁己SUI 直播《陪你这个猪过周日！》2026-08-16 20:05:09'
    );
});

test('extracts a recording timestamp from a replay filename', () => {
    assert.equal(
        formatRecordedAt('', 'D:/录播/2026_08_19/录制-25788785-20260819-214258-099-直播.flv'),
        '2026-08-19 21:42:58'
    );
});

test('normalizes generated merge suffixes without changing the title', () => {
    assert.equal(normalizeStreamTitle('陪你这个猪过周四！_merged'), '陪你这个猪过周四！');
});

test('builds the GPU subtitle profile and accepts the adaptive FFmpeg thread profile', () => {
    const config = buildQueueMediaConfig({
        ownStreamClips: {
            subtitleVideoEncoder: 'h264_nvenc',
            subtitleVideoPreset: 'p4',
            subtitleVideoCq: 23,
            subtitleHwaccel: 'cuda',
            clipFfmpegThreads: 2
        }
    }, { mode: 'busy', ffmpegThreads: 1 });

    assert.deepEqual({
        encoder: config.subtitleVideoEncoder,
        preset: config.subtitleVideoPreset,
        cq: config.subtitleVideoCq,
        hwaccel: config.subtitleHwaccel,
        threads: config.clipFfmpegThreads
    }, {
        encoder: 'h264_nvenc',
        preset: 'p4',
        cq: 23,
        hwaccel: 'cuda',
        threads: 1
    });
});
