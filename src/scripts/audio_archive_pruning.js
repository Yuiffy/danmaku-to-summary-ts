// Extracted archive media traversal; recording naming policy stays with its caller.
const fs = require('fs');
const path = require('path');

async function collectPrunableArchiveVideos(dayDir, { isBakEntryName, isVideoFile, isMergedRecordingVideo }) {
    const resolvedDayDir = path.resolve(dayDir);
    const rootVideos = [];
    const nestedVideos = [];
    const replaySources = new Set();
    let preserveAllRootVideos = false;

    async function walk(currentDir) {
        let entries;
        try {
            entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            if (isBakEntryName(entry.name)) continue;
            if (entry.isDirectory()) {
                await walk(fullPath);
            } else if (entry.isFile() && entry.name.endsWith('.media-retention.json')) {
                try {
                    const recipe = JSON.parse(await fs.promises.readFile(fullPath, 'utf8'));
                    if (recipe.version !== 1 || typeof recipe.sourceMediaPath !== 'string' || !path.isAbsolute(recipe.sourceMediaPath)) preserveAllRootVideos = true;
                    else replaySources.add(path.resolve(recipe.sourceMediaPath));
                } catch { preserveAllRootVideos = true; }
            } else if (entry.isFile() && isVideoFile(fullPath)) {
                if (path.resolve(currentDir) === resolvedDayDir) rootVideos.push(fullPath);
                else nestedVideos.push(fullPath);
            }
        }
    }
    await walk(resolvedDayDir);
    const disposableRootVideos = rootVideos.some(isMergedRecordingVideo)
        ? rootVideos.filter(videoPath => !isMergedRecordingVideo(videoPath) && !preserveAllRootVideos && !replaySources.has(path.resolve(videoPath)))
        : [];
    return [...nestedVideos, ...disposableRootVideos];
}

module.exports = { collectPrunableArchiveVideos };
