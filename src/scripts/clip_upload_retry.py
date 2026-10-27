"""Upload retry decisions, with state adapters supplied by the queue owner."""

import datetime as dt
import json


def record_submission_rate_limit(queue, entry):
    """Append observed 137022s for read-only diagnostics; retry policy is unchanged."""
    current = dt.datetime.fromisoformat(entry['updatedAt'])
    cutoff = current - dt.timedelta(days=7)
    history = []
    for row in queue.get('submissionRateLimitHistory') or []:
        if not isinstance(row, dict):
            continue
        try:
            observed = dt.datetime.fromisoformat(row.get('at', ''))
            if observed.tzinfo is None:
                observed = observed.replace(tzinfo=dt.timezone.utc)
        except (ValueError, TypeError):
            continue
        if observed > cutoff:
            history.append(row)
    history.append({'at': entry['updatedAt'], 'code': entry['code'], 'jobId': entry['jobId']})
    queue['submissionRateLimitHistory'] = history[-2000:]
    queue.setdefault('submissionRateLimitHistorySince', entry['updatedAt'])
    if len(history) > 2000:
        queue['submissionRateLimitHistorySince'] = history[-2000]['at']


def account_pacer(api):
    return api.clip_upload_pacing.UploadPacing(api.configured_upload_account()[0],
        api.QUEUE_PATH.with_name(api.clip_upload_pacing.DATABASE_NAME))


def protection_status(api):
    return api.clip_upload_pacing.protection_status(api.configured_upload_account()[0],
        api.QUEUE_PATH.with_name(api.clip_upload_pacing.DATABASE_NAME))


def send_safety_notification(api, content):
    webhook = api.configured_upload_account()[2]
    if not webhook:
        return False
    response = api.requests.post(webhook, json={'msgtype': 'markdown', 'markdown': {'content': content}}, timeout=10)
    response.raise_for_status()
    if response.json().get('errcode') != 0:
        raise RuntimeError('WeChat Work rejected the upload protection notification')
    return True


def pacing_gate(api):
    pacer = account_pacer(api)
    pacer.deliver_alerts(lambda content: send_safety_notification(api, content))
    state = protection_status(api)
    return (state['paused'] or state['waitSeconds'] > 0 or
            api.clip_upload_pacing.cooldown_remaining(pacer.account_id, pacer.database) > 0)


def show_protection(api):
    status = protection_status(api)
    if status['state']:
        print('[queue] upload protection ' + json.dumps(status, ensure_ascii=False))


def schedule_protection_wait(api, registry, job, ids, output):
    status = protection_status(api)
    api.clear_job_retry_metadata(job)
    ids_list = [int(clip_id) for clip_id in ids]
    api.set_unfinished_clip_statuses(registry, ids_list, 'queued')
    fields = {'retryKind': 'bilibili_upload_paused' if status['paused'] else 'bilibili_upload_slow',
              'error': 'Uploads paused; manual intervention required' if status['paused'] else 'Ten-minute slow mode',
              'lastOutput': str(output or '')[-12000:], 'clipStatuses': api.clip_status_map(registry, ids_list)}
    if not status['paused']:
        fields['retryAt'] = (dt.datetime.now(dt.timezone.utc) +
                            dt.timedelta(seconds=max(status['waitSeconds'], 1))).isoformat()
    api.mark_job(job, 'retry_wait', **fields)
    return 'retry_wait'


def schedule_retry_or_block(api, registry, job, ids, output, reason):
    attempt = int(job.get('attempts') or 0) + 1
    last_output = str(output or '')[-12000:]
    ids_list = [int(clip_id) for clip_id in ids]
    if attempt >= api.MAX_AUTOMATIC_JOB_RETRIES:
        api.set_unfinished_clip_statuses(registry, ids_list, 'failed', reason)
        api.clear_job_retry_metadata(job)
        api.mark_job(job, 'blocked', attempts=attempt,
                     clipStatuses=api.clip_status_map(registry, ids_list), lastOutput=last_output,
                     error=f'automatic retry limit reached: {reason}')
        return 'blocked'
    api.set_unfinished_clip_statuses(registry, ids_list, 'queued')
    retry_at = dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=api.retry_delay_seconds(attempt))
    api.mark_job(job, 'retry_wait', attempts=attempt, retryAt=retry_at.isoformat(),
                 clipStatuses=api.clip_status_map(registry, ids_list), lastOutput=last_output, error=reason)
    return 'retry_wait'


def schedule_http_406_retry(api, registry, job, ids, output):
    """Wait independently of generic error counts; unknown receipts still reconcile."""
    if protection_status(api)['paused']:
        return schedule_protection_wait(api, registry, job, ids, output)
    account_id = api.configured_upload_account()[0]
    remaining = api.clip_upload_pacing.cooldown_remaining(
        account_id, api.QUEUE_PATH.with_name(api.clip_upload_pacing.DATABASE_NAME))
    delay = max(remaining, api.clip_upload_pacing.HTTP_406_WAIT_SECONDS)
    retry_at = dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=delay)
    ids_list = [int(clip_id) for clip_id in ids]
    api.set_unfinished_clip_statuses(registry, ids_list, 'queued')
    api.mark_job(job, 'retry_wait', attempts=int(job.get('attempts') or 0)+1,
                 http406Attempts=int(job.get('http406Attempts') or 0)+1,
                 retryAt=retry_at.isoformat(), retryKind='bilibili_http_406',
                 clipStatuses=api.clip_status_map(registry, ids_list),
                 lastOutput=str(output or '')[-12000:], error='HTTP 406; account cooldown 600s')
    return 'retry_wait'


def resume_uploads(args, api):
    """Explicit operator recovery; retain slow protection after releasing a manual pause."""
    if not api.acquire_lock():
        print(
            "[ERROR] upload worker is running; stop it before resuming uploads",
            file=api.sys.stderr,
        )
        return 3

    try:
        queue = api.load_json(api.QUEUE_PATH, api.default_queue())
        previous_cooldown = queue.get("submissionRateLimit")
        resumed_at = api.now_iso()
        resumed_jobs: list[str] = []
        for job in queue.get("jobs", []):
            is_rate_limit_wait = (
                job.get("status") == "retry_wait"
                and job.get("retryKind") in ("bilibili_submission_rate_limit", "bilibili_upload_paused")
            )
            is_stale_resumed_pending = (
                job.get("status") == "pending"
                and api.is_bilibili_submission_rate_limit(job.get("lastOutput", ""))
            )
            if not (is_rate_limit_wait or is_stale_resumed_pending):
                continue
            previous_attempts = job.get("submissionRateLimitAttempts")
            previous_output = str(job.pop("lastOutput", "") or "")
            api.clear_job_retry_metadata(job)
            extra: dict = {
                "resumedAt": resumed_at,
                "resumeReason": str(args.note or "").strip(),
            }
            if previous_attempts is not None:
                extra["previousSubmissionRateLimitAttempts"] = previous_attempts
            if previous_output:
                extra["previousRateLimitOutput"] = previous_output[-2000:]
            api.mark_job(job, "pending", **extra)
            resumed_jobs.append(str(job.get("id")))

        account_pacer(api).resume(str(args.note or "").strip())
        api.clear_submission_rate_limit(queue)
        queue["lastManualResume"] = {
            "at": resumed_at,
            "reason": str(args.note or "").strip(),
            "previousCooldown": previous_cooldown,
            "jobs": resumed_jobs,
        }
        api.commit_queue_snapshot(
            queue,
            job_ids=resumed_jobs,
            queue_fields=("submissionRateLimit", "lastManualResume"),
        )
        print(
            f"[OK] cleared Bilibili submission cooldown; resumed "
            f"{len(resumed_jobs)} jobs: {','.join(resumed_jobs) or '-'}"
        )
        return 0
    finally:
        api.release_lock()
