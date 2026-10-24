"""Read-only admission for optional speaker processing, evaluated before it starts."""
import json
from pathlib import Path
import time


def speaker_policy_at_finish(policy, device, sample=None, now=None):
    value = dict(policy or {})
    if value.get('mode') != 'auto' or value.get('enabled') is False:
        return value
    reason = None
    if device == 'cpu' or (sample or {}).get('gpu_idle') is False or (sample or {}).get('game_running') is True:
        reason = 'resource_busy'
    try:
        queue_file = Path(value['queue_file'])
        if queue_file.stat().st_size > 16 * 1024 * 1024:
            raise ValueError('Queue snapshot too large')
        tasks = json.loads(queue_file.read_text(encoding='utf-8'))['tasks']
        source = str(Path(value.get('source_path') or '').resolve()).casefold()
        pending = [task for task in tasks if task.get('status') == 'pending'
                   and str(Path(task.get('mediaPath') or '').resolve()).casefold() != source]
        now = time.time() if now is None else now
        waits = [(now - task['addedTime'] / 1000) for task in pending
                 if isinstance(task.get('addedTime'), (int, float)) and 0 < task['addedTime'] <= now * 1000]
        value.update(pendingJobs=len(pending), oldestWaitSeconds=max(waits, default=0), queueKnown=True)
        if not reason and len(pending) >= value.get('max_pending_jobs', 3):
            reason = 'queue_backlog'
        if not reason and value['oldestWaitSeconds'] >= value.get('max_wait_s', 900):
            reason = 'queue_wait'
    except (OSError, ValueError, KeyError, TypeError):
        pass  # Lack of evidence must not be treated as a busy queue.
    return {**value, 'enabled': not reason, 'reason': reason or 'capacity_available'}
