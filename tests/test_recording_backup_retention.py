import json
import os
from pathlib import Path
import sys
import subprocess
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src' / 'scripts'))
import recording_backup_retention as retention


class BackupRetentionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.day = self.root / '123_host' / '2026_01_01'
        self.bak = self.day / 'bak'
        self.bak.mkdir(parents=True)
        self.source = self.bak / 'source.flv'
        self.source.write_bytes(b'original recording')
        self.merged = self.day / 'recording_merged.flv'
        self.merged.write_bytes(b'merged recording')
        self.now = 2_000_000_000
        for file in (self.source, self.merged):
            os.utime(file, (self.now - 8 * 86400, self.now - 8 * 86400))
        self.map = Path(str(self.merged) + '.sources.json')
        self.receipt = {'version': 1, 'outputIdentity': retention.recording_identity(self.merged),
                        'spans': [{'identity': retention.recording_identity(self.source), 'start': 0, 'duration': 100}]}
        self.save_map()

    def save_map(self):
        self.map.write_text(json.dumps(self.receipt), encoding='utf-8')

    def sweep(self, **kwargs):
        return retention.sweep(self.root, kwargs.pop('protected_provider', lambda: []),
                               now=self.now, probe=kwargs.pop('probe', lambda _: 100), **kwargs)

    def test_dry_run_then_delete_only_covered_video_and_preserve_evidence(self):
        xml = self.bak / 'source.xml'
        xml.write_text('unique danmaku', encoding='utf-8')
        self.assertEqual(self.sweep()['plannedBytes'], self.source.stat().st_size)
        self.assertTrue(self.source.exists())
        result = self.sweep(apply=True)
        self.assertEqual(result['deletedFiles'], 1)
        self.assertTrue(xml.exists())
        self.assertTrue(self.merged.exists())
        journal = json.loads((self.day / 'BAK-RETENTION.json').read_text(encoding='utf-8'))
        self.assertEqual(journal['entries'][0]['status'], 'deleted')
        self.assertEqual(self.sweep(apply=True)['deletedFiles'], 0)

    def test_missing_changed_truncated_and_overlapping_replacements_are_preserved(self):
        for change in ('missing', 'identity', 'duration', 'overlap', 'boolean-version', 'invalid-span'):
            with self.subTest(change=change):
                self.save_map()
                if change == 'missing':
                    self.map.unlink()
                elif change == 'identity':
                    self.map.write_text(json.dumps({**self.receipt, 'outputIdentity': 'changed'}))
                elif change == 'overlap':
                    self.map.write_text(json.dumps({**self.receipt, 'spans': self.receipt['spans'] * 2}))
                elif change == 'boolean-version':
                    self.map.write_text(json.dumps({**self.receipt, 'version': True}))
                elif change == 'invalid-span':
                    self.map.write_text(json.dumps({**self.receipt, 'spans': [None]}))
                probe = lambda p: 60 if change == 'duration' and p == self.merged else 100
                self.assertEqual(self.sweep(apply=True, probe=probe)['deletedFiles'], 0)
                self.assertTrue(self.source.exists())

    def test_recent_keep_and_referenced_backups_stay(self):
        os.utime(self.source, (self.now, self.now))
        self.assertEqual(self.sweep()['plannedBytes'], 0)
        os.utime(self.source, (self.now - 8 * 86400,) * 2)
        (self.bak / '.keep').touch()
        self.assertEqual(self.sweep()['plannedBytes'], 0)
        (self.bak / '.keep').unlink()
        for protected in (self.source, self.bak):
            self.assertEqual(self.sweep(protected_provider=lambda: [str(protected)])['plannedBytes'], 0)
        (self.day / 'clip.media-retention.json').write_text(json.dumps({'sourceMediaPath': str(self.source)}))
        self.assertEqual(self.sweep()['plannedBytes'], 0)

    def test_changed_reference_under_lock_prevents_deletion(self):
        count = 0

        def references():
            nonlocal count
            count += 1
            return [] if count == 1 else [str(self.source)]

        result = self.sweep(apply=True, protected_provider=references)
        self.assertEqual(result['deletedFiles'], 0)
        self.assertTrue(result['errors'])
        self.assertTrue(self.source.exists())

    def test_delete_failure_preserves_pending_journal_and_reports_error(self):
        def fail(_):
            raise OSError('locked')

        result = self.sweep(apply=True, remove=fail)
        self.assertTrue(result['errors'])
        journal = json.loads((self.day / 'BAK-RETENTION.json').read_text(encoding='utf-8'))
        self.assertEqual(journal['entries'][0]['status'], 'pending')
        self.assertTrue(self.source.exists())

    def test_changed_original_or_probe_failure_is_not_covered(self):
        self.source.write_bytes(b'different source')
        os.utime(self.source, (self.now - 8 * 86400,) * 2)
        self.assertEqual(self.sweep()['plannedBytes'], 0)

    def test_less_than_seven_days_or_nan_is_rejected(self):
        for days in (0, 6, float('nan')):
            with self.assertRaises(ValueError):
                self.sweep(keep_days=days)

    def test_identity_matches_typescript_producer_for_unicode_large_source(self):
        media = self.bak / '录制-123-20260101-原录播.flv'
        media.write_bytes(bytes(range(256)) * 600)
        project = Path(__file__).resolve().parents[1]
        script = "const m=require('./src/core/media/RecordingCoverage.ts');process.stdout.write(m.recordingIdentity(process.argv[1]))"
        result = subprocess.run(['node', '-r', 'ts-node/register/transpile-only', '-e', script, str(media)],
                                cwd=project, capture_output=True, text=True, encoding='utf-8', check=True, timeout=30)
        self.assertEqual(retention.recording_identity(media), result.stdout)

    def test_new_root_keep_marker_under_lock_prevents_deletion(self):
        from contextlib import contextmanager

        @contextmanager
        def guard():
            (self.root / '.keep').touch()
            yield

        result = self.sweep(apply=True, mutation_guard=guard)
        self.assertEqual(result['deletedFiles'], 0)
        self.assertTrue(self.source.exists())

    def test_completed_backup_directories_do_not_probe_or_rescan_editorial_evidence(self):
        self.source.unlink()
        (self.bak / 'source.xml').write_text('preserve', encoding='utf-8')

        def unexpected(_):
            self.fail('already cleaned backups must not probe replacement media')

        self.assertEqual(self.sweep(probe=unexpected)['plannedBytes'], 0)

    def test_symlink_never_authorizes_deletion(self):
        link = self.bak / 'link.flv'
        try:
            link.symlink_to(self.source)
        except OSError:
            self.skipTest('symlink privilege unavailable')
        result = self.sweep()
        self.assertTrue(any(row['path'] == str(link) for row in result['skipped']))


if __name__ == '__main__':
    unittest.main()
