import copy
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/scripts'))
from stream_game_closing_context import closing_boundary, validate_closing_context
import stream_game_review as original


class ClosingContextTests(unittest.TestCase):
    def setUp(self):
        times = [0, 2, 2.25, 2.5, 2.75, 3, 3.25, 4, 6, 8]
        self.rows = [dict(start=4, end=5, text='最后含混的处理')]
        self.review = dict(version=2, timingSource='original_closing_context', sampleSeconds=2, resolutionSeconds=.25,
            window=dict(start=0, end=8), samples=[dict(index=i+1, time=t) for i, t in enumerate(times)],
            frames=[dict(index=i+1, activity='game' if t < 2 else 'uncertain' if t < 3.25 else 'other', description='actual pixels') for i, t in enumerate(times)],
            contextReview=dict(decision='keep', reason='final handling retained, unrelated aftermath', ownTargetGame=True,
                allPossibleHandlingRetained=True, laterContextUnrelated=True, retainedContentAllowed=True,
                retainedTail=dict(transcriptIndex=1, **self.rows[0])))

    def test_retains_both_unclear_pixels_and_entire_independent_speech(self):
        self.assertEqual(closing_boundary(self.review, self.rows), 5)
        self.review['contextReview']['retainedTail'] = None
        self.assertEqual(closing_boundary(self.review, self.rows), 3.25)

    def test_real_later_activity_uncertainty_cannot_be_cleared_by_no_exit_phrase(self):
        self.review['contextReview']['laterContextUnrelated'] = False
        with self.assertRaisesRegex(ValueError, 'permits later handling'):
            closing_boundary(self.review, self.rows)

    def test_never_selects_earlier_game_frame_before_unknown_exit_pixels(self):
        self.review['frames'][-2]['activity'] = 'uncertain'
        with self.assertRaisesRegex(ValueError, 'bounded final transition'):
            closing_boundary(self.review, self.rows)

    def test_mutated_asr_time_missing_samples_and_duplicate_ids_fail(self):
        for kind in ('row', 'gap', 'index', 'decision'):
            row = copy.deepcopy(self.review)
            if kind == 'row': row['contextReview']['retainedTail']['end'] = 4.5
            if kind == 'gap': row['samples'][-2]['time'] = 5.9
            if kind == 'index': row['samples'][-1]['index'] = 1
            if kind == 'decision': row['contextReview']['decision'] = 'uncertain'
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                closing_boundary(row, self.rows)

    def test_upload_reopens_original_audio_images_receipts_and_raw_context(self, recording_end=False):
        expected = 8 if recording_end else 5
        if recording_end:
            self.review.update(version=3, retentionMode='through_recording_end', sourceDuration=8,
                sampleSeconds=30, resolutionSeconds=None)
            self.review['samples'][-1]['time'] = 7.9
            self.review['frames'][-1]['activity'] = 'uncertain'
            self.review['contextReview'].update(recordingEndRetained=True, laterContextUnrelated=None, retainedTail=None)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = dict(mediaPath=str(root/'source.flv'), mediaBytes='100', mediaMtimeNs='20')
            write = lambda p, v: p.write_text(json.dumps(v, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
            def extraction(file, time, end=None):
                file.write_bytes(b'original extracted evidence')
                args = ['-y', '-ss', str(time), '-i', source['mediaPath']]
                args += (['-t', str(end-time), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '64k']
                         if end is not None else ['-frames:v', '1', '-vf', 'scale=960:-2', '-q:v', '3'])
                args.append(str(file))
                receipt = Path(str(file)+'.complete.json')
                signature = hashlib.sha256(json.dumps(dict(args=args, source=source), ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
                write(receipt, dict(version=3, args=args, source=source, signature=signature, sha256=original.file_digest(file)))
                return dict(path=str(file), sha256=original.file_digest(file), receiptPath=str(receipt), receiptSha256=original.file_digest(receipt))
            audio = extraction(root/'audio-2.mp3', 0, 8)
            asr = root/'ASR.json'; write(asr, dict(segments=self.rows))
            bundle = dict(version=1, method='independent_local_asr', backend='paraformer', source=source,
                start=0, end=8, audioPath=audio['path'], audioSha256=audio['sha256'], receiptPath=audio['receiptPath'],
                receiptSha256=audio['receiptSha256'], settingsSignature='independent-decoder', asrPath=str(asr), asrSha256=original.file_digest(asr))
            provenance = root/'SOURCE.json'; write(provenance, bundle)
            bundle.update(provenancePath=str(provenance), provenanceSha256=original.file_digest(provenance))
            review = copy.deepcopy(self.review)
            evidence = dict(version=1, method='independent_local_asr', primary=bundle, retranscriptions=[])
            review.update(source=source, localAudioEvidence=evidence, end=expected)
            for sample in review['samples']:
                sample.update(extraction(root/f'image-{sample["index"]}.jpg', sample['time']))
            binding = lambda samples: [{k: s[k] for k in ('index', 'time', 'sha256')} for s in samples]
            review['batches'] = []
            for offset in range(0, len(review['samples']), 8):
                samples = review['samples'][offset:offset+8]
                response = root/f'response-{offset}.json'
                write(response, dict(text=json.dumps(dict(reason='actual pixels', frames=review['frames'][offset:offset+8])),
                    requestBinding=dict(version=1, source=source, samples=binding(samples))))
                review['batches'].append(dict(indices=[s['index'] for s in samples], responsePath=str(response), responseSha256=original.file_digest(response)))
            response = root/'context.json'
            request_binding = dict(version=2 if recording_end else 1, source=source,
                window=review['window'], localAudioEvidence=evidence, samples=binding(review['samples']))
            if recording_end:
                request_binding.update(retentionMode='through_recording_end', sourceDuration=8)
            write(response, dict(text=json.dumps(review['contextReview']), requestBinding=request_binding))
            review['contextReview'].update(responsePath=str(response), responseSha256=original.file_digest(response))
            excerpt = dict(decision='keep', observed=True, heardWords=None, timingSource='original_closing_context',
                boundaryAnchor='after_retained_context', seconds=expected, reason='whole context independent check')
            observation = dict(index=2, heardWords=None, timingSource='original_closing_context')
            verdict = dict(version=4, protocolVersion=14, evidenceMethod='independent_local_asr', evidenceDirectory=str(root), end=expected,
                endFrameReview=review, audioObservations=[None, observation], boundaryReview=dict(end=expected, endFrameReview=review,
                audioObservations=[None, observation], excerptReviews=[None, excerpt]))
            check = lambda v: validate_closing_context(v, review['window'], excerpt, 8, source,
                original.file_digest, original.read_independent_audio, original.check_original_extraction)
            self.assertEqual(check(verdict), expected)
            verdict['evidenceDirectory'] = str(root/'new-review')
            self.assertEqual(check(verdict), expected)
            if recording_end:
                changed = copy.deepcopy(verdict); changed['endFrameReview']['sourceDuration'] = 9
                with self.assertRaisesRegex(ValueError, 'source duration'): check(changed)
                changed = copy.deepcopy(verdict); changed['endFrameReview']['contextReview']['recordingEndRetained'] = False
                with self.assertRaisesRegex(ValueError, 'independently verified'): check(changed)
            for key, value in [('start', 1), ('source', {**source, 'mediaBytes': '999'}), ('audioPath', str(root/'other.mp3'))]:
                changed = copy.deepcopy(verdict)
                changed['endFrameReview']['localAudioEvidence']['primary'][key] = value
                with self.subTest(reused_audio_field=key), self.assertRaises(ValueError): check(changed)
            changed = copy.deepcopy(verdict); changed['boundaryReview']['spokenEnd'] = 5
            with self.assertRaisesRegex(ValueError, 'envelope changed'): check(changed)
            changed = copy.deepcopy(verdict); changed['endFrameReview']['batches'].pop()
            with self.assertRaisesRegex(ValueError, 'assessments are incomplete'): check(changed)
            write(response, dict(text='invented approval'))
            with self.assertRaisesRegex(ValueError, 'assessment changed'): check(verdict)

    def test_complete_recording_end_roundtrip_keeps_unknown_pixels_and_does_not_claim_exit(self):
        self.test_upload_reopens_original_audio_images_receipts_and_raw_context(True)


if __name__ == '__main__': unittest.main()
