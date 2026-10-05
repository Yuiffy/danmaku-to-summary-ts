import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from src.scripts.activity_audio_review import check_local_activity, file_digest


class LocalActivityReviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = {'mediaPath': str(self.root/'source.flv'), 'mediaBytes': '2000', 'mediaMtimeNs': '42'}
        def save(name, value):
            path = self.root/name
            path.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
            return str(path)
        self.save = save
        audio = str(self.root/'audio-1.mp3'); Path(audio).write_bytes(b'original sound')
        args = ['-y', '-ss', '100', '-i', self.source['mediaPath'], '-t', '16', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '64k', audio]
        receipt = {'version': 3, 'source': self.source, 'args': args, 'sha256': file_digest(audio)}
        receipt['signature'] = hashlib.sha256(json.dumps({'args': args, 'source': self.source}, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
        save('audio-1.mp3.complete.json', receipt)
        settings = {'chunkSeconds': 8}
        request = {'source': self.source, 'settings': settings, 'audio': [{'path': audio, 'start': 100, 'end': 116, 'sha256': file_digest(audio)}]}
        input_path = save('LOCAL_INPUT.json', request)
        self.local = {'version': 1, 'method': 'independent_local_asr', 'source': self.source, 'settings': settings,
            'audio': [{'index': 1, 'start': 100, 'end': 116, 'sha256': file_digest(audio),
                'chunks': [{'index': 1, 'start': 0, 'end': 8, 'text': 'actual sung lyric'},
                           {'index': 2, 'start': 8, 'end': 16, 'text': '唱得怎么样呀'}], 'transcript': []}]}
        result_path = save('LOCAL_AUDIO.json', self.local)
        receipt_path = save('LOCAL_AUDIO.receipt.json', {'version': 1, 'sha256': file_digest(result_path), 'inputSha256': file_digest(input_path)})
        bundle = {**self.local, 'resultPath': result_path, 'sha256': file_digest(result_path),
            'receiptPath': receipt_path, 'receiptSha256': file_digest(receipt_path)}
        self.raw = {'results': [{'id': 'song-1', 'decision': 'keep', 'performer': 'host', 'startContextClosed': True,
            'endContextClosed': True, 'timeBasis': 'audio_local_seconds', 'evidenceRefs': [{'audioIndex': 1, 'chunkIndex': 1, 'quote': 'actual sung lyric'}],
            'events': [{'kind': 'song', 'start': {'audioIndex': 1, 'seconds': 0}, 'end': {'audioIndex': 1, 'seconds': 16}}]}]}
        self.response = {'text': json.dumps(self.raw), 'requestBinding': {'source': self.source, 'localAudioSha256': bundle['sha256'],
            'candidates': [{'id': 'song-1', 'start': 102, 'end': 112, 'audioIndices': [1]}], 'frames': []}}
        response_path = save('RESPONSE.json', self.response)
        self.event = {'id': 'song-1', 'kind': 'song', 'start': 100, 'end': 116, 'verification': {'decision': 'keep',
            'method': 'independent_local_asr', 'localAudioEvidence': bundle, 'frameEvidence': [],
            'responsePath': response_path, 'responseSha256': file_digest(response_path), 'evidenceRefs': self.raw['results'][0]['evidenceRefs']}}

    def test_bound_independent_lyrics_preserve_complete_source_enclosure(self):
        check_local_activity(self.event, self.source)

    def test_changed_audio_response_or_decoder_cannot_pass(self):
        for path in ('audio-1.mp3', 'RESPONSE.json', 'LOCAL_AUDIO.json'):
            with self.subTest(path=path):
                file = self.root/path; before = file.read_bytes()
                file.write_bytes(b'changed')
                with self.assertRaises(ValueError):
                    check_local_activity(self.event, self.source)
                file.write_bytes(before)

    def test_adjusted_assessment_still_cannot_invent_quotes_or_trim_a_performance(self):
        for change in ('quote', 'audio', 'ownership', 'context', 'boundary'):
            with self.subTest(change=change):
                raw = copy.deepcopy(self.raw); result = raw['results'][0]
                if change == 'quote': result['evidenceRefs'][0]['quote'] = 'invented original lyric'
                if change == 'audio': result['evidenceRefs'][0]['audioIndex'] = 2
                if change == 'ownership': result['performer'] = 'playback'
                if change == 'context': result['endContextClosed'] = False
                if change == 'boundary': result['events'][0]['start']['seconds'] = 5
                event = copy.deepcopy(self.event); response = copy.deepcopy(self.response)
                response['text'] = json.dumps(raw)
                self.save('RESPONSE.json', response)
                event['verification']['responseSha256'] = file_digest(self.root/'RESPONSE.json')
                event['verification']['evidenceRefs'] = result['evidenceRefs']
                if change == 'boundary': event['start'] = 105
                with self.assertRaises(ValueError):
                    check_local_activity(event, self.source)

    def test_separate_preview_revision_replays_announcement_images_and_complete_context(self):
        local = copy.deepcopy(self.local)
        local['audio'][0]['chunks'][1]['text'] = '我开始唱了呀请听'
        self.save('LOCAL_AUDIO.json', local)
        bundle = {**local, **{k:v for k,v in self.event['verification']['localAudioEvidence'].items()
            if k in ('resultPath','receiptPath')}}
        bundle['sha256'] = file_digest(bundle['resultPath'])
        self.save('LOCAL_AUDIO.receipt.json', {'version': 1, 'sha256': bundle['sha256'], 'inputSha256': file_digest(self.root/'LOCAL_INPUT.json')})
        bundle['receiptSha256'] = file_digest(bundle['receiptPath'])
        frame = str(self.root/'frame.jpg'); Path(frame).write_bytes(b'original image')
        args = ['-y','-ss','103','-i',self.source['mediaPath'],'-frames:v','1','-vf','scale=640:-2','-q:v','3',frame]
        receipt = {'version':3, 'source':self.source, 'args':args, 'sha256':file_digest(frame)}
        receipt['signature'] = hashlib.sha256(json.dumps({'args':args,'source':self.source},ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
        self.save('frame.jpg.complete.json', receipt)
        images = [{'activityId':'song-1','time':103,'path':frame,'sha256':file_digest(frame)}]
        revision = {'version':1,'method':'separate_preview_before_performance','preludeKind':'listening_or_rehearsal',
            'previewContextClosed':True,'formalPerformanceComplete':True,'reason':'Separate preview ends before the formal announcement.',
            'announcement':{'audioIndex':1,'chunkIndex':2,'quote':'我开始唱了呀请听'}}
        raw = copy.deepcopy(self.raw); raw['results'][0]['events'][0]['start']['seconds'] = 8
        raw['results'][0]['preludeCorrection'] = revision
        response = copy.deepcopy(self.response)
        response['requestBinding'].update(localAudioSha256=bundle['sha256'],frames=images)
        response['text'] = json.dumps(raw)
        self.save('RESPONSE.json', response)
        event = copy.deepcopy(self.event); event['start'] = 108
        event['verification'].update(localAudioEvidence=bundle,frameEvidence=images,preludeCorrection=revision,
            responseSha256=file_digest(self.root/'RESPONSE.json'))
        check_local_activity(event,self.source)
        for mutate in (lambda r:r.update(previewContextClosed=False), lambda r:r['announcement'].update(quote='怎么唱的呀')):
            changed = copy.deepcopy(raw); mutate(changed['results'][0]['preludeCorrection'])
            response['text'] = json.dumps(changed); self.save('RESPONSE.json',response)
            event['verification'].update(preludeCorrection=changed['results'][0]['preludeCorrection'],responseSha256=file_digest(self.root/'RESPONSE.json'))
            with self.assertRaises(ValueError): check_local_activity(event,self.source)


if __name__ == '__main__':
    unittest.main()
