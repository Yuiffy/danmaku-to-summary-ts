import tempfile
import unittest
from pathlib import Path

from src.scripts.clip_source_timing import digest, validate_rendered_timing_repair


class FeedbackTimingAcceptanceTests(unittest.TestCase):
    def test_feedback_skips_ai_audio_gate_but_keeps_render_and_source_binding(self):
        with tempfile.TemporaryDirectory() as directory:
            files = {}
            for name in ('video', 'subtitles', 'original', 'meta', 'evidence', 'speaker', 'source'):
                file = Path(directory) / name
                file.write_bytes(name.encode())
                files[name] = str(file.resolve())
            stat = Path(files['source']).stat()
            transcript = {'mode': 'repaired_source_audio'}
            for path_key, hash_key, name in (
                ('path', 'sha256', 'subtitles'), ('originalSrtPath', 'originalSrtSha256', 'original'),
                ('metadataPath', 'metadataSha256', 'meta'), ('evidencePath', 'evidenceSha256', 'evidence'),
                ('speakerPath', 'speakerSha256', 'speaker'),
            ):
                transcript[path_key], transcript[hash_key] = files[name], digest(files[name])
            metadata = {'source': {'mediaPath': files['source'], 'srtPath': files['subtitles']},
                        'output': {'mediaPath': files['video'], 'srtPath': files['subtitles']},
                        'window': {'start': 0, 'end': 60},
                        'renderedSubtitles': {'review': {'acceptanceMode': 'feedback'}},
                        'renderedTimingRepair': {'version': 1, 'transcript': transcript,
                            'originalSource': {'mediaPath': files['source'], 'mediaBytes': str(stat.st_size),
                                               'mediaMtimeNs': str(stat.st_mtime_ns)},
                            'rendered': {'window': {'start': 0, 'end': 60},
                                         'video': digest(files['video']), 'subtitles': digest(files['subtitles'])}}}
            self.assertIsNone(validate_rendered_timing_repair(metadata))
            metadata['renderedSubtitles']['review'] = {}
            with self.assertRaisesRegex(ValueError, '独立原音'):
                validate_rendered_timing_repair(metadata)
            metadata['renderedSubtitles']['review'] = {'acceptanceMode': 'feedback'}
            Path(files['video']).write_bytes(b'changed render')
            with self.assertRaisesRegex(ValueError, '修复证据已变更'):
                validate_rendered_timing_repair(metadata)
