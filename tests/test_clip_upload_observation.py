import datetime as dt
import unittest

from src.scripts import clip_upload_registry as registry


class UploadObservationTests(unittest.TestCase):
    def test_actual_rate_limit_retries_survive_cooldown_clear_and_job_output_overwrite(self):
        queue = {'jobs': []}
        job = {'id': 'example', 'status': 'pending', 'clipIds': []}
        registry.schedule_submission_rate_limit_retry({'clips': {}}, queue, job, [], '137022')
        registry.schedule_submission_rate_limit_retry({'clips': {}}, queue, job, [], '137022')
        registry.clear_submission_rate_limit(queue)
        job['lastOutput'] = 'success'
        self.assertNotIn('submissionRateLimit', queue)
        self.assertEqual(len(queue['submissionRateLimitHistory']), 2)
        self.assertEqual(queue['submissionRateLimitHistory'][0]['code'], 137022)
        self.assertEqual(queue['submissionRateLimitHistory'][0]['jobId'], 'example')
        self.assertIn('submissionRateLimitHistorySince', queue)

    def test_non_observation_cooldown_recovery_does_not_invent_new_incidents(self):
        queue = {}
        registry.set_submission_rate_limit_cooldown(queue, 'recovered', 1)
        self.assertNotIn('submissionRateLimitHistory', queue)

    def test_history_is_bounded_without_changing_cooldown_state(self):
        current = dt.datetime(2026, 10, 27, tzinfo=dt.timezone.utc)
        queue = {'submissionRateLimitHistory': [
            {'at': (current - dt.timedelta(days=8)).isoformat(), 'code': 137022},
            {'at': 'broken'}, None,
            *[{'at': (current - dt.timedelta(seconds=i)).isoformat(), 'code': 137022}
              for i in range(2001, 0, -1)]]}
        entry = {'updatedAt': current.isoformat(), 'code': 137022, 'jobId': 'example'}
        registry.clip_upload_retry.record_submission_rate_limit(queue, entry)
        self.assertEqual(len(queue['submissionRateLimitHistory']), 2000)
        self.assertEqual(queue['submissionRateLimitHistory'][-1]['at'], current.isoformat())
        self.assertEqual(queue['submissionRateLimitHistorySince'], queue['submissionRateLimitHistory'][0]['at'])
        self.assertNotIn('submissionRateLimit', queue)
