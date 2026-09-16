"""Cover edits preserve unrelated live metadata and settings."""

import copy
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "scripts"))
import update_cover


class UpdateCoverTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.archive = {"title": "Existing title", "copyright": 2, "source": "Original source",
                        "tag": "one,two", "desc_format_id": 9999, "desc": "Existing description",
                        "dynamic": "", "tid": 21, "no_reprint": 0, "attribute": 0}
        self.detail = {"archive": copy.deepcopy(self.archive), "origin_state": 0,
                       "arc_elec": {"state": 1}, "reply": {"state": 0, "up_selection": True},
                       "subtitle": {"allow": True, "lan": "zh-CN"},
                       "videos": [{"cid": 123, "title": "Part title", "desc": "Part description", "filename": "original-file"}]}
        detail = self.detail
        self.submit = AsyncMock()
        submit = self.submit

        class Editor:
            def __init__(self, **options):
                self.meta = options["meta"]
                self._VideoEditor__old_configs = detail

            async def _fetch_configs(self):
                pass

            async def _submit(self):
                await submit(copy.deepcopy(self.meta))

        self.editor_patch = patch.object(update_cover, "VideoEditor", Editor)
        self.editor_patch.start()
        self.addCleanup(self.editor_patch.stop)

    async def test_changes_cover_without_resetting_copy_parts_or_switches(self):
        await update_cover.submit_cover("BVfixture", None, self.archive, "https://archive.biliimg.com/bfs/archive/new.jpg")
        payload = self.submit.call_args.args[0]
        for field in ("title", "copyright", "source", "tag", "desc_format_id", "desc", "dynamic", "tid", "no_reprint"):
            self.assertEqual(payload[field], self.archive[field])
        self.assertEqual(payload["videos"], self.detail["videos"])
        self.assertEqual(payload["open_elec"], 0)
        self.assertTrue(payload["up_selection_reply"])
        self.assertEqual(payload["subtitles"], {"open": 1, "lan": "zh-CN"})
        self.assertTrue(payload["cover"].endswith("/new.jpg"))

    async def test_keeps_enabled_charging_enabled(self):
        self.detail["arc_elec"]["state"] = 0
        await update_cover.submit_cover("BVfixture", None, self.archive, "cover")
        self.assertEqual(self.submit.call_args.args[0]["open_elec"], 1)

    async def test_refuses_to_overwrite_a_concurrent_copy_edit(self):
        self.detail["archive"]["title"] = "New live title"
        with self.assertRaisesRegex(RuntimeError, "changed while preparing"):
            await update_cover.submit_cover("BVfixture", None, self.archive, "cover")
        self.submit.assert_not_called()

    async def test_refuses_unmapped_archive_controls(self):
        self.detail["archive"]["attribute"] = 8
        with self.assertRaisesRegex(RuntimeError, "explicit cover-only"):
            await update_cover.submit_cover("BVfixture", None, self.archive, "cover")
        self.submit.assert_not_called()

    async def test_refuses_unmapped_reply_controls(self):
        self.detail["reply"]["state"] = 1
        with self.assertRaisesRegex(RuntimeError, "explicit cover-only"):
            await update_cover.submit_cover("BVfixture", None, self.archive, "cover")
        self.submit.assert_not_called()


if __name__ == "__main__":
    unittest.main()
