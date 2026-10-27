"""SDK upload telemetry, separate from authorization and submission receipts."""
import json
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path


def progress_path(media_path):
    return Path(str(media_path) + '.upload-progress.json')


def read_progress(clip):
    try:
        value = json.loads(progress_path(clip['mediaPath']).read_text(encoding='utf-8'))
        if (isinstance(value, dict) and value.get('version') == 1
                and value.get('mediaPath') == clip['mediaPath']
                and all(key in value for key in ('totalParts', 'partPercent', 'overallPercent', 'phase', 'updatedAt'))):
            value['stale'] = (clip.get('status') in ('queued', 'uploading')
                              and value.get('updatedAt', '') < clip.get('updatedAt', ''))
            return value
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return None


def format_progress(value):
    part = value.get('partIndex')
    return (f"P{part or '-'}/{value['totalParts']} 本P {value['partPercent']:.1f}% "
            f"整包 {value['overallPercent']:.1f}% 阶段={value['phase']} "
            f"更新={value['updatedAt']}" + (' (上次尝试)' if value.get('stale') else ''))


class UploadProgress:
    def __init__(self, pages, media_path, *, sink=None, clock=time.monotonic, event_sink=None):
        self.pages = pages
        self.media_path = str(media_path)
        self.sink = sink or self.persist
        self.clock = clock
        self.event_sink = event_sink
        self.last_emit = float('-inf')
        self.run_id = uuid.uuid4().hex
        self.chunks = [set() for _ in pages]
        self.totals = [0 for _ in pages]
        self.complete = set()
        self.part = None
        self.phase = 'starting'
        self.terminal = False
        self.last_event = None
        self.failure_stage = None

    def persist(self, value):
        target = progress_path(self.media_path)
        temporary = target.with_name(target.name + '.' + self.run_id + '.tmp')
        try:
            temporary.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
            temporary.replace(target)
        except OSError:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
        print('[UPLOAD_PROGRESS] ' + format_progress(value), flush=True)

    def emit(self, force=False):
        now = self.clock()
        if not force and now - self.last_emit < 60:
            return
        fractions = [1 if i in self.complete else len(done) / total if total else 0
                     for i, (done, total) in enumerate(zip(self.chunks, self.totals))]
        value = {'version': 1, 'runId': self.run_id, 'mediaPath': self.media_path,
                 'phase': self.phase, 'partIndex': None if self.part is None else self.part + 1,
                 'totalParts': len(self.pages), 'completedParts': len(self.complete),
                 'completedChunks': len(self.chunks[self.part]) if self.part is not None else 0,
                 'totalChunks': self.totals[self.part] if self.part is not None else 0,
                 'partPercent': 100 * fractions[self.part] if self.part is not None else 0,
                 'overallPercent': 100 * sum(fractions) / len(fractions),
                 'lastEvent': self.last_event, 'failureStage': self.failure_stage,
                 'updatedAt': datetime.now(timezone.utc).isoformat()}
        self.sink(value)
        self.last_emit = now

    def event(self, name, data):
        if self.terminal:
            return
        data = data or {}
        page = data.get('page')
        index = next((i for i, p in enumerate(self.pages) if p is page), None)
        if index is None and name not in ('PRE_COVER', 'AFTER_COVER', 'PRE_SUBMIT', 'COVER_FAILED', 'SUBMIT_FAILED'):
            return
        if index is not None:
            self.part = index
        self.last_event = name
        if name in ('PREUPLOAD_FAILED', 'PAGE_SUBMIT_FAILED', 'COVER_FAILED', 'SUBMIT_FAILED'):
            self.failure_stage = {'PREUPLOAD_FAILED': 'preupload', 'PAGE_SUBMIT_FAILED': 'processing_part',
                                  'COVER_FAILED': 'cover', 'SUBMIT_FAILED': 'submitting'}[name]
        if self.event_sink and name in ('AFTER_PAGE', 'PRE_SUBMIT'):
            self.event_sink(name, None if index is None else index+1)
        if name in ('PRE_CHUNK', 'AFTER_CHUNK', 'CHUNK_FAILED'):
            total, number = data.get('total_chunk_count'), data.get('chunk_number')
            if type(total) is not int or type(number) is not int or not 0 <= number < total:
                return
            self.totals[index] = total
            if name == 'AFTER_CHUNK':
                self.chunks[index].add(number)
            self.phase = 'retrying_chunk' if name == 'CHUNK_FAILED' else 'uploading'
        elif name in ('PREUPLOAD', 'PRE_PAGE'):
            self.phase = 'preupload' if name == 'PREUPLOAD' else 'uploading'
        elif name == 'PRE_PAGE_SUBMIT':
            self.phase = 'processing_part'
        elif name == 'AFTER_PAGE':
            self.complete.add(index)
            self.phase = 'part_complete'
        elif name in ('PRE_COVER', 'AFTER_COVER'):
            self.phase = 'cover'
        elif name == 'PRE_SUBMIT':
            self.phase = 'submitting'
        self.emit()

    async def run(self, uploader):
        for name in ('PREUPLOAD', 'PRE_PAGE', 'PRE_CHUNK', 'AFTER_CHUNK', 'CHUNK_FAILED', 'PRE_PAGE_SUBMIT',
                     'AFTER_PAGE', 'PRE_COVER', 'AFTER_COVER', 'PRE_SUBMIT',
                     'PREUPLOAD_FAILED', 'PAGE_SUBMIT_FAILED', 'COVER_FAILED', 'SUBMIT_FAILED'):
            uploader.add_event_listener(name, lambda data, event=name: self.event(event, data))
        self.emit(force=True)
        try:
            result = await uploader.start()
        except BaseException:
            self.terminal = True
            self.failure_stage = self.failure_stage or self.phase
            self.phase = 'failed'
            self.emit(force=True)
            raise
        self.terminal = True
        self.phase = 'completed' if isinstance(result, dict) and result.get('bvid') else 'failed'
        if self.phase == 'completed':
            self.complete.update(range(len(self.pages)))
        self.emit(force=True)
        return result
