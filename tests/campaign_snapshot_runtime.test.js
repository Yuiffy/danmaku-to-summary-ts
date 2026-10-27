const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

test('snapshot CLI dependencies load in native Node without a TypeScript dev loader or queue access', () => {
    const output = execFileSync(process.execPath, ['-e', [
        'const coverage = require("./src/core/media/RecordingCoverage.ts");',
        'const snapshot = require("./src/scripts/campaign_snapshot.ts");',
        'if (typeof coverage.resolveRecordingPrefix !== "function" || typeof snapshot.triggerCampaignSnapshot !== "function") throw Error("missing exports");',
        'console.log("loaded");'
    ].join('\n')], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', windowsHide: true, env: { ...process.env, NODE_OPTIONS: '' } });
    assert.equal(output.trim(), 'loaded');
});
