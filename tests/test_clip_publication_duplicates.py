import unittest

from src.scripts.clip_publication_duplicates import duplicate_errors


class ClipPublicationDuplicatesTests(unittest.TestCase):
    def setUp(self):
        self.old = {'id': 3700, 'status': 'uploaded', 'title': 'Original title',
                    'sourceMediaPath': r'D:\recordings\录制-25788785-20261021-220029-854-source.flv',
                    'start': '01:14:31.539', 'duration': 244.681,
                    'uploadState': {'bvid': 'BVOLD'}}
        self.new = {**self.old, 'id': 3701, 'status': 'review', 'title': 'Changed title',
                    'start': 4546.289, 'duration': 169.931, 'uploadState': {},
                    'mediaPath': 'new-render.mp4', 'metadataPath': 'new.json'}

    def errors(self, clips=None, records=None, metadata=None):
        return duplicate_errors(clips or [self.new], records or [self.old, self.new],
                                lambda key: (metadata or {}).get(key, {}))

    def test_renamed_contained_highlight_is_blocked_by_prior_bv(self):
        errors = self.errors()
        self.assertEqual(len(errors), 1)
        self.assertIn('3700 (BVOLD)', errors[0])

    def test_small_boundary_change_and_archive_root_move_do_not_reset_identity(self):
        self.new['sourceMediaPath'] = self.old['sourceMediaPath'].replace('D:', 'E:')
        self.assertTrue(self.errors(metadata={'new.json': {'window': {'start': 4500, 'end': 4720}}}))

    def test_legacy_review_record_is_compared_using_source_label_and_clock(self):
        self.old.pop('sourceMediaPath')
        for clip in (self.old, self.new):
            clip.update(source='小岁 直播 2026-10-21 22:00:29', roomId='25788785')
        self.assertTrue(self.errors())

    def test_missing_registry_source_path_reads_metadata_despite_changed_source_label(self):
        source = self.old.pop('sourceMediaPath')
        self.old.update(metadataPath='old.json', source='Old recording description', roomId='25788785')
        self.new.update(source='Updated recording description', roomId='25788785')
        self.assertTrue(self.errors(metadata={'old.json': {'source': {'mediaPath': source}}}))

    def test_feedback_acceptance_and_revised_media_cannot_bypass_overlap(self):
        self.assertTrue(self.errors(metadata={'new.json': {
            'editorialReplan': {'acceptanceMode': 'feedback', 'checkedPeers': []},
            'window': {'start': 4546.289, 'end': 4716.22}}}))

    def test_two_incoming_ids_cannot_reserve_same_content(self):
        self.old['status'] = 'review'
        self.old.pop('uploadState')
        self.assertTrue(self.errors(clips=[self.old, self.new]))
        self.assertEqual(self.errors(), [])  # An unrelated unapproved draft is not a reservation.

    def test_same_id_and_different_recordings_are_allowed(self):
        self.assertEqual(self.errors(clips=[self.old]), [])
        self.new['sourceMediaPath'] = self.new['sourceMediaPath'].replace('20261021', '20261022')
        self.assertEqual(self.errors(), [])

    def test_unresolved_submission_reserves_coverage_after_job_failure_or_cancellation(self):
        self.old.update(status='failed', uploadState={}, mediaPath='old.mp4', statePath='state.json')
        for status in ('failed', 'review', 'cancelled'):
            self.old['status'] = status
            self.assertTrue(self.errors(metadata={'state.json': {'submission_intents': {
                'media:bound': {'mediaPath': 'old.mp4', 'title': 'Previously submitted title'}}}}))
        self.assertEqual(self.errors(), [])

    def test_shared_short_context_tail_is_allowed(self):
        self.new.update(start=4710, duration=150)
        self.assertEqual(self.errors(), [])

    def test_same_rendered_file_is_blocked_without_source_windows(self):
        self.old = {'id': 1, 'status': 'uploaded', 'mediaPath': r'D:\clips\one.mp4'}
        self.new = {'id': 2, 'status': 'review', 'mediaPath': 'd:/clips/one.mp4'}
        self.assertTrue(self.errors())

    def test_full_archive_and_independent_highlight_have_different_purposes(self):
        self.old['activityReviewRequired'] = True
        self.old['prefix'] = '【岁己同步视听】'
        self.assertEqual(self.errors(), [])
        self.new.update(activityReviewRequired=True, prefix=self.old['prefix'])
        self.assertTrue(self.errors())
        self.assertTrue(self.errors(metadata={'new.json': {'type': 'stream_activity_submission', 'kind': 'watch'}}))

    def test_multipart_gaps_are_not_duplicate_coverage(self):
        for clip in (self.old, self.new):
            clip.update(gameReviewRequired=True)
        self.old['parts'] = [{'start': 0, 'end': 100}, {'start': 500, 'end': 600}]
        self.new['parts'] = [{'start': 200, 'end': 300}]
        self.assertEqual(self.errors(), [])
        self.new['parts'] = [{'start': 510, 'end': 570}]
        self.assertTrue(self.errors())

    def test_compilation_output_duration_is_not_treated_as_source_coverage(self):
        self.old.update(publicationKind='game_highlight_compilation', start=0, duration=1200)
        self.new.update(start=100, duration=100)
        self.assertEqual(self.errors(), [])


if __name__ == '__main__':
    unittest.main()
