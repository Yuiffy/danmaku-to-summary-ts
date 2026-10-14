import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from src.scripts.activity_audio_review import check_local_activity, file_digest, unresolved_activity_issues


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

    def test_optional_native_listening_rechecks_original_audio_and_local_timestamps(self):
        request = json.loads((self.root/'LOCAL_INPUT.json').read_text())
        raw = dict(timeBasis='audio_local_seconds', observations=[dict(id='song-1', ownership='host',
            chronology=[dict(audioIndex=1, start=0, end=16, kind='host_singing')])])
        listening = dict(version=1, protocolVersion=2, source=self.source, inputs=request['audio'], observations=raw['observations'],
            response=dict(text=json.dumps(raw), meta=dict(apiMode='gemini_native')))
        for changed in (False, True):
            if changed:
                raw['observations'][0]['chronology'][0].update(start=100,end=116)
                listening['response']['text'] = json.dumps(raw)
            file = self.save('NATIVE.json', listening)
            reference = dict(path=file, sha256=file_digest(file))
            self.response['requestBinding']['nativeListening'] = reference
            self.save('RESPONSE.json', self.response)
            self.event['verification'].update(nativeListening=reference, responseSha256=file_digest(self.root/'RESPONSE.json'))
            if changed:
                with self.assertRaisesRegex(ValueError, 'outside original audio'): check_local_activity(self.event,self.source)
            else:
                check_local_activity(self.event,self.source)

    def test_service_outage_or_missing_assessment_is_a_review_hold(self):
        for key in ('localAudioEvidence', 'responsePath', 'responseSha256', 'decision'):
            with self.subTest(key=key):
                event = copy.deepcopy(self.event)
                event['verification'].pop(key)
                with self.assertRaisesRegex(ValueError, 'completed independent assessment'):
                    check_local_activity(event, self.source)
        self.event['verification'] = {'method': 'independent_local_asr', 'decision': 'uncertain', 'reason': 'HTTP 502'}
        with self.assertRaisesRegex(ValueError, 'completed independent assessment'):
            check_local_activity(self.event, self.source)

    def test_segmented_listening_revalidates_audio_partition_and_clock_mapping(self):
        request = json.loads((self.root/'LOCAL_INPUT.json').read_text())
        segments = []; inputs = []
        for i in range(2):
            file = str(self.root/f'segment-{i}.mp3'); Path(file).write_bytes(b'segment sound')
            start = 100 + 8 * i; end = start + 8
            args = ['-y', '-ss', str(start), '-i', self.source['mediaPath'], '-t', '8', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '64k', file]
            receipt = dict(version=3, source=self.source, args=args, sha256=file_digest(file))
            receipt['signature'] = hashlib.sha256(json.dumps({'args': args, 'source': self.source}, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
            self.save(f'segment-{i}.mp3.complete.json', receipt)
            segments.append(dict(path=file, start=start, end=end, originalAudioIndex=1))
            inputs.append(dict(path=file, start=start, end=end, sha256=file_digest(file)))
        raw = dict(timeBasis='audio_local_seconds', observations=[dict(id='song-1', ownership='host', chronology=[
            dict(audioIndex=i+1, start=0, end=8, kind='host_singing') for i in range(2)])])
        nested = dict(version=1, protocolVersion=2, source=self.source, inputs=inputs, observations=raw['observations'],
            response=dict(text=json.dumps(raw), meta=dict(apiMode='gemini_native')))
        mapped = copy.deepcopy(raw['observations'])
        mapped[0]['chronology'][1].update(audioIndex=1, start=8, end=16)
        listening = dict(version=1, protocolVersion=3, source=self.source, inputs=request['audio'], response=nested['response'],
            observations=mapped, segments=dict(audio=segments, listening=nested))
        def check(value):
            file = self.save('NATIVE.json', value); reference = dict(path=file, sha256=file_digest(file))
            self.response['requestBinding']['nativeListening'] = reference
            self.save('RESPONSE.json', self.response)
            self.event['verification'].update(nativeListening=reference, responseSha256=file_digest(self.root/'RESPONSE.json'))
            check_local_activity(self.event, self.source)
        check(listening)
        wrong = copy.deepcopy(listening); wrong['observations'][0]['chronology'][1]['start'] = 9
        with self.assertRaisesRegex(ValueError, 'chronology changed'): check(wrong)
        wrong = copy.deepcopy(listening); wrong['segments']['audio'][1]['start'] = 109
        with self.assertRaisesRegex(ValueError, 'coverage changed'): check(wrong)
        Path(segments[0]['path']).write_bytes(b'changed sound')
        with self.assertRaisesRegex(ValueError, 'extraction'): check(listening)

    def test_closed_enclosure_preserves_uncertain_exact_onset_without_waiving_other_issues(self):
        self.event.update(startObserved=False, endObserved=False,
            reviewIssues=['start_boundary_unconfirmed', 'end_boundary_unconfirmed', 'source_transcript_timing_unreliable'])
        self.event['verification']['boundaryPolicy'] = 'complete_context_enclosure'
        check_local_activity(self.event, self.source)
        self.assertEqual(unresolved_activity_issues(self.event), ['source_transcript_timing_unreliable'])
        self.raw['results'][0]['startContextClosed'] = False
        self.response['text'] = json.dumps(self.raw)
        self.save('RESPONSE.json', self.response)
        self.event['verification']['responseSha256'] = file_digest(self.root/'RESPONSE.json')
        with self.assertRaisesRegex(ValueError, 'complete context'):
            check_local_activity(self.event, self.source)

    def test_short_literal_quote_supplements_but_does_not_replace_substantial_context(self):
        # Three-character boundary phrase in a real independently bound chunk.
        self.raw['results'][0]['evidenceRefs'].append({'audioIndex': 1, 'chunkIndex': 2, 'quote': '怎么样'})
        self.response['text'] = json.dumps(self.raw)
        self.save('RESPONSE.json', self.response)
        self.event['verification']['responseSha256'] = file_digest(self.root/'RESPONSE.json')
        check_local_activity(self.event, self.source)
        self.raw['results'][0]['evidenceRefs'].pop(0)
        self.response['text'] = json.dumps(self.raw)
        self.save('RESPONSE.json', self.response)
        self.event['verification']['responseSha256'] = file_digest(self.root/'RESPONSE.json')
        with self.assertRaisesRegex(ValueError, 'substantial'):
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
        self._check_prelude_variant()

    def test_playback_restart_requires_repeated_opening_and_independent_selection(self):
        self._check_prelude_variant(restart=True)

    def test_trial_singing_can_precede_a_complete_restart_with_bound_native_evidence(self):
        self._check_prelude_variant(restart=True, preview=True)

    def _check_prelude_variant(self, restart=False, preview=False):
        local = copy.deepcopy(self.local)
        local['audio'][0]['chunks'][1]['text'] = '我开始唱了呀请听'
        if restart:
            local['audio'][0]['chunks'] = [dict(index=i+1,start=i*4,end=(i+1)*4,text=text) for i,text in enumerate(
                ['春天的晚风吹过山坡','这首歌我们来唱吧','春天的晚风吹过山坡','唱完了谢谢大家'])]
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
        if restart:
            revision.update(version=2,method='playback_then_restarted_performance',preludeKind='playback',
                priorPlaybackConfirmed=True,openingRestartConfirmed=True,
                announcement=dict(audioIndex=1,chunkIndex=2,quote='这首歌我们来唱吧'),
                openingBefore=dict(audioIndex=1,chunkIndex=1,quote='春天的晚风吹过山坡'),
                openingAfter=dict(audioIndex=1,chunkIndex=3,quote='春天的晚风吹过山坡'))
            raw['results'][0]['evidenceRefs'] = [revision['announcement']]
            raw['results'][0]['events'][0]['start']['seconds'] = 4
            response['requestBinding']['candidates'][0]['start'] = 100
        response['requestBinding'].update(localAudioSha256=bundle['sha256'],frames=images)
        if preview:
            revision.update(version=3, method='preview_then_complete_restart', preludeKind='listening_or_rehearsal', noUniqueVerseLost=True)
            response['requestBinding']['candidates'][0]['allowPreviewRestart'] = True
            request = json.loads((self.root/'LOCAL_INPUT.json').read_text())
            native = dict(timeBasis='audio_local_seconds', observations=[dict(id='song-1', ownership='host',
                chronology=[dict(audioIndex=1,start=0,end=16,kind='host_singing')])])
            inputs = request['audio'] + [{k:f[k] for k in ('path','sha256','time','activityId')} for f in images]
            file = self.save('NATIVE.json', dict(version=1,protocolVersion=2,source=self.source,inputs=inputs,observations=native['observations'],
                response=dict(text=json.dumps(native),meta=dict(apiMode='gemini_native'))))
            response['requestBinding']['nativeListening'] = dict(path=file,sha256=file_digest(file))
        response['text'] = json.dumps(raw)
        self.save('RESPONSE.json', response)
        event = copy.deepcopy(self.event); event['start'] = 104 if restart else 108
        event['verification']['evidenceRefs'] = raw['results'][0]['evidenceRefs']
        event['verification'].update(localAudioEvidence=bundle,frameEvidence=images,preludeCorrection=revision,
            responseSha256=file_digest(self.root/'RESPONSE.json'))
        if preview:
            event['verification']['nativeListening'] = response['requestBinding']['nativeListening']
        check_local_activity(event,self.source)
        if preview:
            revision['noUniqueVerseLost'] = False
            response['text'] = json.dumps(raw); self.save('RESPONSE.json', response)
            event['verification']['responseSha256'] = file_digest(self.root/'RESPONSE.json')
            with self.assertRaisesRegex(ValueError, 'unique verse'): check_local_activity(event,self.source)
            revision['noUniqueVerseLost'] = True
        for mutate in (lambda r:r.update(previewContextClosed=False), lambda r:r['announcement'].update(quote='怎么唱的呀')):
            changed = copy.deepcopy(raw); mutate(changed['results'][0]['preludeCorrection'])
            response['text'] = json.dumps(changed); self.save('RESPONSE.json',response)
            event['verification'].update(preludeCorrection=changed['results'][0]['preludeCorrection'],responseSha256=file_digest(self.root/'RESPONSE.json'))
            with self.assertRaises(ValueError): check_local_activity(event,self.source)


if __name__ == '__main__':
    unittest.main()
