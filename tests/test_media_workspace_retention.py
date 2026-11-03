"""Offline workspace expiry tests; no live queues, providers, or publication."""
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src' / 'scripts'))
import media_workspace_retention as retention
from media_workspace_policy import cache_relative_path, workspace_expiry


class WorkspaceRetentionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'workspaces'
        self.workspace = Path(retention.create_workspace(self.root, 'episode-01')['workspace'])
        self.now = 1800000000
        self.media = self.workspace / 'scratch' / 'part.mkv'
        self.media.write_bytes(b'disposable preview')
        os.utime(self.media, (self.now - 9 * 86400,) * 2)
        self.manifest = {'version': 1, 'status': 'completed', 'completedAt': self.now - 8 * 86400,
                         'keepDays': 7, 'cacheEntries': [{'kind': 'scratch', 'path': 'scratch/part.mkv',
                                                       'identity': retention.file_identity(self.media)}]}
        self.save()

    def save(self):
        retention.atomic_json(self.workspace / retention.MANIFEST, self.manifest)

    def sweep(self, apply=True, provider=lambda: set(), **kwargs):
        return retention.sweep_workspaces(self.root, provider, apply=apply, now=self.now, **kwargs)

    def test_deletes_only_declared_media_and_keeps_evidence_and_final(self):
        final = self.workspace / 'final.mp4'
        final.write_bytes(b'final')
        subtitle = self.workspace / 'scratch' / 'final.srt'
        subtitle.write_text('reviewed subtitles', encoding='utf-8')
        undeclared = self.workspace / 'scratch' / 'other.mp4'
        undeclared.write_bytes(b'not declared')
        result = self.sweep()
        self.assertEqual(result['deletedFiles'], 1)
        self.assertFalse(self.media.exists())
        self.assertTrue(all(p.exists() for p in (final, subtitle, undeclared)))
        self.assertIn('scratch/part.mkv', (self.workspace / 'RETENTION.json').read_text())
        self.assertEqual(self.sweep()['deletedFiles'], 0)

    def test_preview_never_deletes(self):
        result = self.sweep(apply=False)
        self.assertEqual(result['plannedBytes'], self.media.stat().st_size)
        self.assertEqual(result['deletedBytes'], 0)
        self.assertTrue(self.media.exists())

    def test_active_and_recent_completion_are_retained(self):
        for update in ({'status': 'active'}, {'completedAt': self.now - 6 * 86400}):
            with self.subTest(update=update):
                manifest = {**self.manifest, **update}
                self.assertEqual(retention.plan_workspace(self.workspace, manifest, self.now)[0], [])

    def test_exact_seven_day_boundary(self):
        manifest = {**self.manifest, 'completedAt': self.now - 7 * 86400}
        self.assertFalse(workspace_expiry(manifest, self.now - 0.001))
        self.assertTrue(workspace_expiry(manifest, self.now))

    def test_invalid_policy_rejected(self):
        for days in (0, 6, True, float('nan'), float('inf')):
            with self.subTest(days=days), self.assertRaises(ValueError):
                workspace_expiry({**self.manifest, 'keepDays': days}, self.now)

    def test_malformed_entry_is_reported_without_deleting_other_files(self):
        self.manifest['cacheEntries'] = [None, {'path': 'scratch/part.mkv'}]
        self.save()
        result = self.sweep()
        self.assertEqual(result['deletedFiles'], 0)
        self.assertEqual(len(result['skipped']), 2)
        self.assertTrue(self.media.exists())

    def test_traversal_absolute_and_sidecar_paths_rejected(self):
        for path in ('../source.mp4', '/source.mp4', 'D:/source.mp4', 'scratch/../source.mp4',
                     'scratch\\part.mkv', 'scratch/a.json', 'scratch//a.mp4', 'final.mp4'):
            with self.subTest(path=path), self.assertRaises(ValueError):
                cache_relative_path({**self.manifest['cacheEntries'][0], 'path': path})

    def test_changed_cache_is_retained(self):
        self.media.write_bytes(b'new render')
        self.assertEqual(self.sweep()['deletedFiles'], 0)
        self.assertTrue(self.media.exists())

    def test_recent_touch_is_retained_even_with_updated_identity(self):
        os.utime(self.media, (self.now,) * 2)
        self.manifest['cacheEntries'][0]['identity'] = retention.file_identity(self.media)
        self.save()
        self.assertEqual(self.sweep()['deletedFiles'], 0)

    def test_registry_exact_or_directory_reference_protects_cache(self):
        for path in (self.media, self.media.parent, self.workspace):
            with self.subTest(path=path):
                self.assertEqual(self.sweep(provider=lambda: {str(path)})['deletedFiles'], 0)

    def test_runtime_protection_reads_pending_metadata_and_completed_media(self):
        runtime = Path(self.temp.name) / 'runtime'
        runtime.mkdir()
        metadata = runtime / 'metadata.json'
        retention.atomic_json(metadata, {'source': {'mediaPath': str(self.media)}})
        registry_path, queue_path = runtime / 'registry.json', runtime / 'queue.json'
        retention.atomic_json(registry_path, {'clips': {
            '1': {'status': 'pending', 'metadataPath': str(metadata)},
            '2': {'status': 'uploaded', 'mediaPath': str(self.workspace / 'final.mp4')}}})
        retention.atomic_json(queue_path, {'jobs': []})
        retention.atomic_json(runtime / 'manual_clip_queue.json', {'tasks': [
            {'status': 'rendering', 'output': str(self.workspace / 'scratch')}]})
        api = SimpleNamespace(REGISTRY_PATH=registry_path, QUEUE_PATH=queue_path, RUNTIME_DIR=runtime)
        with patch.dict(sys.modules, {'clip_upload_registry': api}):
            protected = retention.runtime_protection(self.root)
        self.assertIn(str(self.media.resolve()), protected)
        self.assertIn(str((self.workspace / 'final.mp4').resolve()), protected)
        self.assertIn(str(self.media.parent.resolve()), protected)

    def test_unrelated_recording_references_do_not_touch_the_filesystem(self):
        with patch.object(Path, 'resolve', side_effect=AssertionError('unrelated path resolved')):
            references = list(retention.referenced_workspace_paths(
                {'media': str(Path(self.temp.name) / 'archive' / 'original.flv')},
                {os.path.normcase(str(self.root))}))
        self.assertEqual(references, [])

    def test_protection_is_checked_again_before_delete(self):
        with patch.object(retention, 'plan_workspace', wraps=retention.plan_workspace) as planner:
            calls = iter([set(), {str(self.media)}])
            result = self.sweep(provider=lambda: next(calls))
            self.assertEqual(result['deletedFiles'], 0)
            self.assertEqual(planner.call_count, 2)

    def test_remux_needs_unchanged_existing_original(self):
        source = Path(self.temp.name) / 'original.flv'
        source.write_bytes(b'original')
        entry = {**self.manifest['cacheEntries'][0], 'kind': 'remux', 'source': str(source),
                 'sourceIdentity': retention.file_identity(source),
                 'rebuild': {'method': 'stream-copy-from-origin', 'origin': 123.45}}
        self.manifest['cacheEntries'] = [entry]
        self.save()
        source.write_bytes(b'changed original')
        self.assertEqual(self.sweep()['deletedFiles'], 0)
        source.unlink()
        self.assertEqual(self.sweep()['deletedFiles'], 0)

    def test_valid_remux_can_expire(self):
        source = Path(self.temp.name) / 'original.flv'
        source.write_bytes(b'original')
        self.manifest['cacheEntries'][0].update(kind='remux', source=str(source),
            sourceIdentity=retention.file_identity(source),
            rebuild={'method': 'stream-copy-from-origin', 'origin': 123.45})
        self.save()
        self.assertEqual(self.sweep()['deletedFiles'], 1)
        self.assertTrue(source.exists())

    def test_failed_delete_is_reported_and_journal_kept(self):
        def locked(_):
            raise PermissionError('media is locked')
        result = self.sweep(remove=locked)
        self.assertTrue(result['errors'])
        self.assertTrue(self.media.exists())
        journal = retention.load_json(self.workspace / 'RETENTION.json')
        self.assertEqual(journal['pending']['path'], 'scratch/part.mkv')

    def test_close_registers_media_but_preserves_documents_and_outputs(self):
        (self.workspace / 'scratch' / 'subtitles.srt').write_text('words', encoding='utf-8')
        (self.workspace / 'scratch' / 'helper.ts').write_text('export {};', encoding='utf-8')
        (self.workspace / 'final.mp4').write_bytes(b'final')
        with patch.object(retention.time, 'time', return_value=self.now):
            result = retention.close_workspace(self.root, self.workspace.name)
        manifest = retention.load_json(self.workspace / retention.MANIFEST)
        self.assertEqual(result['cacheFiles'], 1)
        self.assertEqual(manifest['completedAt'], self.now)
        self.assertFalse(workspace_expiry(manifest, self.now))

    def test_linked_cache_is_never_deleted(self):
        outside = Path(self.temp.name) / 'outside.mkv'
        outside.write_bytes(b'keep')
        self.media.unlink()
        try:
            self.media.symlink_to(outside)
        except OSError:
            self.skipTest('symlink creation unavailable')
        self.assertEqual(self.sweep()['deletedFiles'], 0)
        self.assertTrue(outside.exists())


if __name__ == '__main__':
    unittest.main()
