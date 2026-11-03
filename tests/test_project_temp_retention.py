import os
import tempfile
import time
import unittest
from pathlib import Path

from src.scripts.project_temp_retention import plan, sweep


class ProjectTempRetentionTests(unittest.TestCase):
    def test_plan_keeps_recent_marked_and_links(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            old = root / 'old'
            old.mkdir()
            (old / 'x.txt').write_text('x', encoding='utf8')
            recent = root / 'recent'
            recent.mkdir()
            (recent / 'x.txt').write_text('x', encoding='utf8')
            marked = root / 'marked'
            marked.mkdir()
            (marked / '.keep').write_text('', encoding='utf8')
            now = time.time()
            old_time = now - 8 * 86400
            os.utime(old, (old_time, old_time))
            os.utime(old / 'x.txt', (old_time, old_time))
            planned, skipped = plan(root, now=now)
            self.assertEqual([row['path'] for row in planned], ['old'])
            reasons = {row['path']: row['reason'] for row in skipped}
            self.assertEqual(reasons['recent'], 'recently modified')
            self.assertEqual(reasons['marked'], '.keep marker')

    def test_apply_rechecks_and_reports_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            old = root / 'old'
            old.mkdir()
            (old / 'x.bin').write_bytes(b'1234')
            old_time = time.time() - 8 * 86400
            os.utime(old, (old_time, old_time))
            os.utime(old / 'x.bin', (old_time, old_time))
            report = sweep(root, apply=True, now=time.time())
            self.assertFalse(old.exists())
            self.assertEqual(report['deletedBytes'], 4)
            self.assertEqual(report['deletedEntries'], 1)


if __name__ == '__main__':
    unittest.main()
