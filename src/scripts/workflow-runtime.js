// Compatibility bridge for source CLIs. Runtime dependencies are Node builtins only.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

let release;

function resolveRelease() {
    if (release) return release;
    const projectRoot = path.resolve(__dirname, '../..');
    let releaseDir = process.env.DANMAKU_WORKFLOW_RELEASE;
    if (!releaseDir) {
        const pointer = path.join(projectRoot, 'data/runtime/workflow-release.json');
        if (!fs.existsSync(pointer)) {
            throw new Error('Compiled workflows are not activated. Run npm run workflow:activate.');
        }
        releaseDir = JSON.parse(fs.readFileSync(pointer, 'utf8')).releaseDir;
    }
    if (typeof releaseDir !== 'string' || !path.isAbsolute(releaseDir)) {
        throw new Error('Workflow release directory must be an absolute path');
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(releaseDir, 'manifest.json'), 'utf8'));
    if (manifest.schemaVersion !== 1 || !manifest.files || !manifest.entries || !manifest.version) {
        throw new Error('Unsupported or incomplete workflow release manifest');
    }
    for (const [relative, digest] of Object.entries(manifest.files)) {
        const fullPath = path.resolve(releaseDir, relative);
        const within = path.relative(releaseDir, fullPath);
        if (within.startsWith('..') || path.isAbsolute(within)) throw new Error('Invalid workflow manifest path');
        const actual = createHash('sha256').update(fs.readFileSync(fullPath)).digest('hex');
        if (actual !== digest) throw new Error(`Workflow release integrity mismatch: ${relative}`);
    }
    for (const entry of Object.values(manifest.entries)) {
        if (typeof entry !== 'string' || !entry.endsWith('.js') || !manifest.files[entry]) {
            throw new Error('Incomplete workflow entrypoint');
        }
    }
    release = { releaseDir, manifest };
    return release;
}

function loadWorkflow(name) {
    const { releaseDir, manifest } = resolveRelease();
    const entry = manifest.entries[name];
    if (!entry) throw new Error(`Unknown compiled workflow: ${name}`);
    return require(path.join(releaseDir, entry));
}

function checkRuntime() {
    const { releaseDir, manifest } = resolveRelease();
    for (const name of Object.keys(manifest.entries)) loadWorkflow(name);
    return { releaseDir, version: manifest.version, entries: Object.keys(manifest.entries) };
}

module.exports = { loadWorkflow, checkRuntime };
