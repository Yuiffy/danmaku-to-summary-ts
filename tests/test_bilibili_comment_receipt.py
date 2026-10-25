import importlib.util
import unittest
from pathlib import Path
from unittest.mock import AsyncMock

SCRIPT = Path(__file__).resolve().parents[1] / 'src/scripts/bilibili_comment_receipt.py'
spec = importlib.util.spec_from_file_location('comment_receipt_test_target', SCRIPT)
receipt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receipt)


class ReceiptTest(unittest.IsolatedAsyncioTestCase):
    def row(self, **values):
        return dict({'rpid_str': '98765432109876543210', 'member': {'mid': '42'}, 'ctime': 1001,
                     'root': 0, 'content': {'message': 'Exact comment'}}, **values)

    def test_matches_only_bound_author_time_text_and_image(self):
        match = lambda row, image=False: receipt.match_receipt([row], '42', 'Exact comment', 1000000, image)
        self.assertEqual(match(self.row())['replyId'], '98765432109876543210')
        for row in [self.row(member={'mid': '43'}), self.row(ctime=990), self.row(ctime=1121),
                    self.row(root=123), self.row(content={'message': 'different'}), self.row(rpid_str='')]:
            self.assertIsNone(match(row))
        self.assertIsNone(match(self.row(), True))
        image = self.row(content={'message': 'Exact comment', 'pictures': [{'img_src': 'image-url'}]})
        self.assertEqual(match(image, True)['imageUrl'], 'image-url')
        self.assertIsNone(match(image))

    def test_multiple_distinct_matches_are_not_a_unique_receipt(self):
        row = self.row()
        self.assertIsNone(receipt.match_receipt([row, self.row(rpid_str='999')], '42', 'Exact comment', 1000000))
        self.assertIsNotNone(receipt.match_receipt([row, row], '42', 'Exact comment', 1000000))

    async def test_reads_later_pages_and_never_sends(self):
        read = AsyncMock(side_effect=[{'replies': [self.row(member={'mid': 'other'})]}, {'replies': [self.row()], 'page': {'count': 2}}])
        result = await receipt.find_receipt(read, '42', 'Exact comment', 1000000)
        self.assertEqual(result['replyId'], '98765432109876543210')
        self.assertEqual(read.await_count, 2)

    async def test_unknown_is_bounded_to_three_pages(self):
        read = AsyncMock(return_value={'replies': [self.row(member={'mid': 'other'})]})
        self.assertIsNone(await receipt.find_receipt(read, '42', 'Exact comment', 1000000))
        self.assertEqual(read.await_count, 3)
