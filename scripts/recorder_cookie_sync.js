'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');

function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function parseJson(bytes, label) {
  try { return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { throw new Error(`Invalid ${label} JSON`); }
}

function parseCookie(value) {
  if (typeof value !== 'string') throw new Error('Cookie is missing');
  const fields = Object.fromEntries(value.split(';').filter(part => part.includes('=')).map(part => {
    const at = part.indexOf('=');
    return [part.slice(0, at).trim(), part.slice(at + 1).trim()];
  }));
  for (const key of ['DedeUserID', 'SESSDATA', 'bili_jct', 'buvid3']) {
    if (!fields[key]) throw new Error(`Cookie is missing ${key}`);
  }
  if (!/^\d+$/.test(fields.DedeUserID)) throw new Error('Invalid cookie account ID');
  return fields;
}

// Return fingerprints and file identities only. Cookies never enter watchdog
// state, command lines, error messages, or notifications.
function readCookieSyncPlan(options) {
  const sourceBytes = fs.readFileSync(options.sourcePath);
  const recorderBytes = fs.readFileSync(options.recorderConfigPath);
  const source = parseCookie(parseJson(sourceBytes, 'credential source').bilibili?.cookie);
  const recorder = parseCookie(parseJson(recorderBytes, 'recorder config').global?.Cookie?.Value);
  if (source.DedeUserID !== recorder.DedeUserID) throw new Error('Credential source and recorder accounts differ');
  const keys = ['DedeUserID', 'SESSDATA', 'bili_jct', 'buvid3', 'buvid4'];
  const changed = keys.some(key => source[key] !== recorder[key]);
  return { changed, sourceHash: hash(sourceBytes), configHash: hash(recorderBytes),
    fingerprint: hash(keys.map(key => source[key] || '').join('\0')) };
}

module.exports = { readCookieSyncPlan };
