'use strict';

const path = require('path');
const { retainComicSource } = require('./source_lifetime');

function resolveComicSourceVideo(mediaFiles, highlightPath, isAudioFile) {
    const normalize = name => name.replace(/\.speaker$/iu, '').replace(/_fix$/iu, '');
    const base = normalize(path.basename(highlightPath).replace(/_AI_HIGHLIGHT\.txt$/u, ''));
    const videos = mediaFiles.filter(file => !isAudioFile(file));
    return videos.find(file => normalize(path.basename(file, path.extname(file))) === base)
        || (videos.length === 1 ? videos[0] : null);
}

function automaticComicOptions(roomId) {
    return String(roomId) === '25788785' ? {
        tuziRetryMaxAttempts: 4,
        tuziBypassCooldown: false,
        tuziRetryMaxTotalSeconds: 1500,
        tuziRetryMaxCooldownWaitSeconds: 300,
        tuziSkipChatFallbackOnImageApiFailure: true,
        allowComicScriptFallback: true
    } : { tuziRetryMaxAttempts: 2, tuziBypassCooldown: false };
}

async function runComicWithConcurrentClips(options) {
    const log = options.log || console.warn;
    const startedAt = Date.now();
    const timing = { requestedOverlap: options.overlapEnabled === true, overlapUsed: false,
        startedAt: new Date(startedAt).toISOString(), clipLaunchRequestedAt: null,
        sourcePreparationMs: 0, comicPreparationMs: null, comicGenerationMs: null };
    let retained = null;
    if (options.overlapEnabled && options.sourceVideoPath) {
        try {
            retained = await (options.retainSource || retainComicSource)(options.sourceVideoPath, options.tempRoot, { log });
            retained?.readerStarting();
        } catch (error) {
            await retained?.release();
            retained = null;
            log(`Cannot prepare a retained source; keep sequential clipping: ${error.message}`);
        }
    }
    timing.overlapUsed = Boolean(retained);
    timing.sourcePreparationMs = Date.now() - startedAt;
    let kickoff;
    const startClips = reason => {
        if (!kickoff) kickoff = Promise.resolve().then(() => {
            timing.clipLaunchRequestedAt = new Date().toISOString();
            return options.startClips(reason);
        }).catch(error => {
            log(`Background clip startup failed; comic continues: ${error.message}`);
        });
        return kickoff;
    };
    let preparationStartedAt;
    let generationStartedAt;
    try {
        if (retained) await startClips('comic-source-retained');
        preparationStartedAt = Date.now();
        await options.prepareComic();
        timing.comicPreparationMs = Date.now() - preparationStartedAt;
        generationStartedAt = Date.now();
        return await options.generateComic({
            sourceVideoPath: retained?.path || options.sourceVideoPath,
            onComicScriptReady: () => startClips('comic-script-ready'),
            onProcessStarted: retained ? pid => retained.registerReader(pid) : undefined
        });
    } finally {
        if (kickoff) await kickoff;
        await retained?.release();
        if (generationStartedAt !== undefined) timing.comicGenerationMs = Date.now() - generationStartedAt;
        else if (preparationStartedAt !== undefined) timing.comicPreparationMs = Date.now() - preparationStartedAt;
        try { options.onSchedule?.({ ...timing, finishedAt: new Date().toISOString(), totalMs: Date.now() - startedAt }); }
        catch (error) { log(`Cannot record comic/clip schedule: ${error.message}`); }
    }
}

module.exports = { runComicWithConcurrentClips, resolveComicSourceVideo, automaticComicOptions };
