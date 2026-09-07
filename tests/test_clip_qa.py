import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src' / 'scripts'))
from clip_qa import validate_metadata_qa, validate_registry_qa
from clip_upload_manifest import load_upload_manifest


class ClipQualityGateTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        output = {}
        hashes = {}
        for field, key in [('mediaPath', 'video'), ('coverPath', 'cover'), ('srtPath', 'subtitles')]:
            file = self.root / key
            file.write_bytes(key.encode())
            output[field] = str(file)
            hashes[key] = hashlib.sha256(key.encode()).hexdigest()
        copy = {'title': 'Title', 'coverText': 'Cover', 'description': 'Description'}
        hashes['copy'] = hashlib.sha256('Title\0Cover\0Description'.encode()).hexdigest()
        self.metadata = {'copy': copy, 'output': output, 'qaRequired': True, 'uploadReady': True,
                         'qaResult': {'version': 1, 'status': 'passed', 'digests': hashes}}
        self.file = self.root / 'metadata.json'
        self.file.write_text(json.dumps(self.metadata), encoding='utf-8')

    def tearDown(self):
        self.temp.cleanup()

    def test_unchanged_review_passes_but_never_grants_authorization(self):
        validate_metadata_qa(self.metadata)
        self.assertNotIn('uploadApproved', self.metadata)
        clips = load_upload_manifest(self.file)
        self.assertTrue(clips[0]['qaRequired'])

    def test_changed_media_copy_cover_or_subtitles_require_new_review(self):
        for field in ('mediaPath', 'coverPath', 'srtPath'):
            file = Path(self.metadata['output'][field])
            original = file.read_bytes()
            file.write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'changed'):
                validate_metadata_qa(self.metadata)
            file.write_bytes(original)
        self.metadata['copy']['title'] = 'Changed'
        with self.assertRaisesRegex(ValueError, 'changed'):
            validate_metadata_qa(self.metadata)

    def test_failed_qa_not_importable_and_legacy_still_works(self):
        self.metadata['qaResult']['status'] = 'failed'
        self.file.write_text(json.dumps(self.metadata), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'not passed'):
            load_upload_manifest(self.file)
        validate_metadata_qa({'copy': {'title': 'Legacy'}})

    def test_registry_edits_or_removed_quality_metadata_are_blocked(self):
        clip = {'qaRequired': True, 'metadataPath': str(self.file), 'title': 'Title', 'description': 'Description',
                'mediaPath': self.metadata['output']['mediaPath'], 'coverPath': self.metadata['output']['coverPath']}
        self.assertEqual(validate_registry_qa([[clip]]), [])
        clip['title'] = 'Changed'
        self.assertTrue(validate_registry_qa([[clip]]))
        self.file.unlink()
        self.assertTrue(validate_registry_qa([[clip]]))
        self.assertEqual(validate_registry_qa([[{'metadataPath': str(self.file)}]]), [])


if __name__ == '__main__':
    unittest.main()
