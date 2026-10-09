import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from src.scripts import bilibili_upload_capabilities as capabilities


class Response:
    def __init__(self, data):
        self.data = data

    def raise_for_status(self):
        pass

    def json(self):
        return {"code": 0, "data": self.data}


class UploadCapabilityTests(unittest.TestCase):
    def fetch(self, multipart=True, collection=True):
        seen = []

        def get(url, **kwargs):
            seen.append(url)
            if url.endswith('/archive/white'):
                return Response({'have_permission_of_p': multipart, 'season': True,
                                 'season_add_multip': collection,
                                 'new_web_edit': {'max_count': 200, 'single_max_count': 100}})
            if url.endswith('/archive/pre'):
                return Response({'myinfo': {'mid': 42, 'subtitle': False,
                                 'uploadsize': {'8-16': True}, 'uploadduration': {'3-10': False}}})
            # This is the misleading creator-platform response that caused the
            # regression: the same field does not establish uploader permission.
            if url.endswith('/white'):
                return Response({'have_permission_of_p': False, 'season': True})
            self.fail(url)

        result = capabilities.fetch_capabilities('fixture', get=get)
        self.assertEqual(seen, ['https://member.bilibili.com/x/vupre/web/archive/white',
                                'https://member.bilibili.com/x/vupre/web/archive/pre'])
        return result

    def test_uploader_permission_wins_over_platform_flag(self):
        result = self.fetch()
        self.assertTrue(result['multipartAllowed'])
        self.assertTrue(result['multipartCollectionAllowed'])
        self.assertEqual(result['maxParts'], 200)
        self.assertEqual(result['maxPartsPerAdd'], 100)
        self.assertEqual(result['maxFileBytes'], 16 * 1024 ** 3)
        self.assertEqual(result['uploadChannel'], 'web')

    def test_closed_uploader_permission_still_blocks_a_multipart_bundle(self):
        current = self.fetch(multipart=False)
        with patch.object(capabilities, 'load_cookie', return_value='fixture'), \
                patch.object(capabilities, 'fetch_capabilities', return_value=current):
            with self.assertRaisesRegex(ValueError, 'multipart permission unavailable'):
                capabilities.validate_upload_parts([{}, {}])

    def test_collection_permission_is_independent_of_multipart_upload_permission(self):
        current = self.fetch(collection=False)
        self.assertTrue(current['multipartAllowed'])
        self.assertTrue(current['collectionAllowed'])
        with tempfile.TemporaryDirectory() as directory:
            media = Path(directory) / 'P.mp4'
            media.write_bytes(b'fixture')
            part = {'mediaPath': str(media), 'actualDuration': 30}
            with patch.object(capabilities, 'load_cookie', return_value='fixture'), \
                    patch.object(capabilities, 'fetch_capabilities', return_value=current):
                capabilities.validate_upload_parts([part])
                with self.assertRaisesRegex(ValueError, 'multipart collection permission unavailable'):
                    capabilities.validate_upload_parts([part, part])


if __name__ == '__main__':
    unittest.main()
