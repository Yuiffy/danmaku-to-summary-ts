const path = require('path');

function normalizedSegments(value) {
    return path.resolve(String(value || '')).split(path.sep).filter(Boolean);
}

function resolveClipOutputParent(mediaPath, config = {}) {
    const sourceParent = path.dirname(path.resolve(mediaPath));
    const archiveRoot = String(config.archiveSourceRoot || '').trim();
    const activeRoot = String(config.activeOutputRoot || '').trim();
    if (!archiveRoot || !activeRoot) return sourceParent;

    const sourceSegments = normalizedSegments(sourceParent);
    const archiveSegments = normalizedSegments(archiveRoot);
    const isArchiveChild = archiveSegments.every((segment, index) =>
        sourceSegments[index]?.toLocaleLowerCase() === segment.toLocaleLowerCase()
    );
    if (!isArchiveChild) return sourceParent;

    const relativeSegments = sourceSegments.slice(archiveSegments.length);
    return path.join(path.resolve(activeRoot), ...relativeSegments);
}

function resolveClipOutputRoot(mediaPath, config = {}) {
    return path.join(resolveClipOutputParent(mediaPath, config), config.outputDirName);
}

module.exports = { resolveClipOutputParent, resolveClipOutputRoot };
