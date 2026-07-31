const fs = require('fs');
const os = require('os');
const path = require('path');

const catalog = require('./speaker_reference_catalog');

describe('speaker_reference_catalog', () => {
  test('returns every supported state reference for the same speaker', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speaker-reference-catalog-'));
    const calmPath = path.join(tempDir, 'shiori-calm.wav');
    const excitedPath = path.join(tempDir, 'shiori-excited.wav');
    const manifestPath = path.join(tempDir, 'manifest.json');
    fs.writeFileSync(calmPath, '');
    fs.writeFileSync(excitedPath, '');
    fs.writeFileSync(manifestPath, JSON.stringify([
      {
        speaker: '栞栞',
        key: 'shiori_calm',
        audio_path: calmPath,
        state: 'calm'
      },
      {
        speaker: '栞栞',
        key: 'shiori_excited',
        audio_path: excitedPath,
        state: 'excited'
      }
    ]));

    try {
      const status = catalog.getStreamerReferenceStatus(
        { displayName: '栞栞', speakerLabels: ['栞栞'] },
        { asr: {} },
        manifestPath
      );
      const references = catalog.buildSpeakerReferencesForParticipants(
        [{ displayName: '栞栞', speakerLabels: ['栞栞'] }],
        { asr: {} },
        manifestPath
      );

      expect(status.status).toBe('ready');
      expect(status.references).toHaveLength(2);
      expect(references).toEqual([
        { speaker: '栞栞', audio_path: calmPath, state: 'calm' },
        { speaker: '栞栞', audio_path: excitedPath, state: 'excited' }
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
