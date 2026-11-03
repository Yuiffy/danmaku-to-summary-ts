import copy
import hashlib
import json
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/scripts'))
import stream_game_review as review
from stream_game_preparation_review import FLAGS, preparation_boundary, validate_preparation
import test_stream_game_upload as game_upload_tests


class PreparationReviewTests(unittest.TestCase):
    def setUp(self):
        self.base = game_upload_tests.GameUploadTests(); self.base.setUp()
        self.addCleanup(self.base.tearDown)
        v = self.base.silent_start_fixture(); v['protocolVersion'] = 13
        self.source = self.base.data['sourceSnapshot']; root = self.base.root
        identity = {k: self.source[k] for k in ('mediaPath', 'mediaBytes', 'mediaMtimeNs')}
        self.witness = copy.deepcopy(self.base.data['activities'][0]); self.witness['gameId'] = 'elden-ring'
        audio = root/'prep.mp3'; audio.write_bytes(b'original setup audio')
        args = ['-y', '-ss', '0', '-i', self.source['mediaPath'], '-t', '4.9', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '64k', str(audio)]
        receipt = Path(str(audio)+'.complete.json')
        signature = hashlib.sha256(json.dumps(dict(args=args, source=identity), ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
        receipt.write_text(json.dumps(dict(version=3, args=args, source=identity, signature=signature, sha256=review.file_digest(audio))), encoding='utf-8')
        self.rows = [dict(start=.5, end=1.5, text='编译正在进行'), dict(start=2, end=2.5, text='设置完了')]
        asr = root/'prep-asr.json'; asr.write_text(json.dumps(dict(segments=self.rows)), encoding='utf-8')
        primary = dict(version=1, method='independent_local_asr', backend='paraformer', source=identity,
            start=0, end=4.9, audioPath=str(audio), audioSha256=review.file_digest(audio), receiptPath=str(receipt),
            receiptSha256=review.file_digest(receipt), settingsSignature='independent-decoder', asrPath=str(asr), asrSha256=review.file_digest(asr))
        provenance = root/'prep-source.json'; provenance.write_text(json.dumps(primary), encoding='utf-8')
        primary.update(provenancePath=str(provenance), provenanceSha256=review.file_digest(provenance))
        context = dict(decision='keep', reason='same-game actual preparation then unrelated activity', **{k: True for k in FLAGS},
            firstRetainedRow=dict(transcriptIndex=1, **self.rows[0]), lastRetainedRow=dict(transcriptIndex=2, **self.rows[1]))
        self.evidence = dict(version=1, method='independent_preparation_context', source=identity, gameId='elden-ring',
            candidate=dict(id='prep', start=0, end=3), window=dict(start=0, end=4.9), primary=primary,
            frames=[v['originalFrameEvidence'][0]], chapters=[], witnessEvent=self.witness, contextReview=context,
            boundary=dict(start=.5, end=2.5))
        raw = dict(text=json.dumps(context), requestBinding={k:self.evidence[k] for k in ('version','source','gameId','candidate','window','primary','frames','chapters','witnessEvent')})
        response = root/'prep-response.json'; response.write_text(json.dumps(raw), encoding='utf-8')
        context.update(responsePath=str(response), responseSha256=review.file_digest(response))
        self.event = dict(id='prep', gameId='elden-ring', start=.5, end=2.5, chapters=[], reviewIssues=[],
            verification=dict(version=4, protocolVersion=14, evidenceMethod='independent_local_asr', verificationKind='preparation_only',
                decision='keep', publicCopySupported=True, startObserved=True, endObserved=True, start=.5, end=2.5, preparationReview=self.evidence))

    def check(self, event):
        validate_preparation(event, self.source, 60, 'elden-ring', review.file_digest, review.read_independent_audio,
            review.check_original_extraction, lambda w: review.check_game_verification(w, self.source, 60, 'elden-ring', allow_preparation=False))

    def test_reopens_full_original_context_and_independently_revalidates_later_gameplay(self):
        self.check(self.event)
        review.check_game_verification(self.event, self.source, 60, 'elden-ring')
        changed = copy.deepcopy(self.event)
        changed['verification']['preparationReview']['witnessEvent']['verification']['frameObservations'][0]['activity'] = 'other'
        with self.assertRaises(ValueError): self.check(changed)

    def test_no_gameplay_preparation_or_different_game_cannot_witness_setup(self):
        for key, value in [('gameId', 'other'), ('verificationKind', 'preparation_only'), ('decision', 'uncertain')]:
            changed = copy.deepcopy(self.evidence)
            target = changed['witnessEvent'] if key == 'gameId' else changed['witnessEvent']['verification']
            target[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError): preparation_boundary(changed, self.rows)

    def test_identity_and_last_retained_row_cannot_be_invented(self):
        for flag in FLAGS:
            changed = copy.deepcopy(self.evidence); changed['contextReview'][flag] = False
            with self.subTest(flag=flag), self.assertRaises(ValueError): preparation_boundary(changed, self.rows)
        changed = copy.deepcopy(self.evidence); changed['contextReview']['lastRetainedRow']['end'] = 2.4
        with self.assertRaises(ValueError): preparation_boundary(changed, self.rows)


if __name__ == '__main__': unittest.main()
