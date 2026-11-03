import argparse
import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from src.scripts import clip_upload_registry as registry
from src.scripts.precision_bundle_review import approve_bundle, validate_bundle, _snapshot
from src.scripts.clip_qa import validate_metadata_qa


class PrecisionBundleReviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.directory = self.root / 'bundle' / 'r-one'
        self.directory.mkdir(parents=True)

        def put(name, value):
            file = self.root / name
            file.write_text(json.dumps(value) if isinstance(value, dict) else value, encoding='utf-8')
            return str(file)
        self.put = put
        source = dict(mediaPath=put('source.mp4', 'source-video'), srtPath=put('source.srt', 'source-speech'))
        members, mappings, records = [], [], {}
        for i in (1, 2):
            window = dict(start=i * 10, end=i * 10 + 5)
            metadata = put(f'{i}.json', dict(source=source, window=window))
            subtitle = put(f'{i}.srt', 'candidate-speech')
            digest = lambda file: hashlib.sha256(Path(file).read_bytes()).hexdigest()
            stat = Path(source['mediaPath']).stat()
            members.append(dict(id=i, metadataPath=metadata, metadataSha256=digest(metadata), candidateSrtPath=subtitle,
                candidateSrtSha256=digest(subtitle), sourceSnapshot=dict(mediaPath=source['mediaPath'], bytes=stat.st_size,
                    mtimeMs=stat.st_mtime_ns / 1e6, srtSha256=digest(source['srtPath']))))
            mappings.append(dict(id=i, originalWindow=window, keywordSpans=[dict(start=(i-1)*5+1, end=(i-1)*5+2)]))
            records[str(i)] = dict(id=i, status='pending_cut', metadataPath=metadata)
        manifest = put('members.json', dict(members=members))
        output = dict(mediaPath=put('final.mp4', 'final-video'), srtPath=put('final.srt', 'final-speech'),
            coverPath=put('cover.jpg', 'cover'), burnedSubtitles=True, metadataPath=str(self.directory/'clip.json'))
        public_copy = dict(title='Two topics', description='Independent topics in order', coverText='Two topics')
        qa = dict(version=1, status='passed', issues=[], digests=dict(video=digest(output['mediaPath']),
            subtitles=digest(output['srtPath']), cover=digest(output['coverPath']),
            copy=hashlib.sha256('\0'.join(public_copy[k] for k in ('title','coverText','description')).encode()).hexdigest()))
        self.metadata = dict(mode='keyword_topic_bundle', publicationKind='keyword_topic_bundle', source=source,
            window=dict(start=0,end=10,duration=9), roomId='other-room', copy=public_copy, output=output,
            qaRequired=True, qaResult=qa, audioQa=dict(status='passed', issues=[]), creativeResult=dict(status='edited'),
            editPlan=dict(keep=[dict(start=0,end=10)]), uploadReady=False, candidateBundle=dict(version=1, ids=[1,2],
                mappings=mappings, membersPath=manifest, membersSha256=digest(manifest), uploadAuthorized=False))
        Path(output['metadataPath']).write_text(json.dumps(self.metadata),encoding='utf-8')
        (self.directory/'RESULT.json').write_text(json.dumps(dict(status='pending_review',metadataPath=output['metadataPath'])),encoding='utf-8')
        self.registry_path = self.root / 'registry.json'
        self.queue_path = self.root / 'queue.json'
        self.registry_path.write_text(json.dumps(dict(nextClipId=3,clips=records,batches={})),encoding='utf-8')
        self.queue_path.write_text(json.dumps(dict(jobs=[])),encoding='utf-8')

    def test_pending_bundle_has_no_publication_authority(self):
        validate_bundle(self.metadata, require_approval=False)
        with self.assertRaisesRegex(ValueError,'publication approval'):
            validate_metadata_qa(self.metadata)

    def test_changes_to_original_members_and_retained_keyword_are_rejected(self):
        changed = copy.deepcopy(self.metadata)
        changed['editPlan']['keep'] = [dict(start=0,end=5)]
        with self.assertRaisesRegex(ValueError,'omitted member'):
            validate_bundle(changed,require_approval=False)
        self.put('2.srt','changed words')
        with self.assertRaisesRegex(ValueError,'candidate changed'):
            validate_bundle(self.metadata,require_approval=False)

    def test_approval_import_is_idempotent_absorbs_members_and_never_enqueues(self):
        args = argparse.Namespace(revision=str(self.directory),review_note='User: publish when checks pass')
        result = type('Result', (), dict(returncode=0,stderr='',stdout='BUNDLE_SOURCE: '+json.dumps(_snapshot(self.metadata['source']))))()
        with patch.object(registry,'REGISTRY_PATH',self.registry_path), patch.object(registry,'QUEUE_PATH',self.queue_path), \
                patch.object(registry,'RUNTIME_DIR',self.root), patch.object(registry.subprocess,'run',return_value=result):
            self.assertEqual(approve_bundle(args,registry),0)
            self.assertEqual(approve_bundle(args,registry),0)
            data=json.loads(self.registry_path.read_text())
            self.assertEqual(data['nextClipId'],4)
            self.assertEqual(len(data['clips']),3)
            self.assertEqual(data['clips']['1']['status'],'cancelled')
            self.assertEqual(data['clips']['2']['status'],'cancelled')
            self.assertEqual(data['clips']['3']['status'],'review')
            self.assertEqual(json.loads(self.queue_path.read_text())['jobs'],[])
            approved=json.loads((self.directory.parent/'PUBLICATION.json').read_text())
            self.assertIs(approved['bundlePublicationReview']['audioVisualReviewed'],False)
            validate_metadata_qa(approved)
            self.put('final.mp4','changed media')
            with self.assertRaisesRegex(ValueError,'artifacts changed'):
                validate_metadata_qa(approved)


if __name__ == '__main__':
    unittest.main()
