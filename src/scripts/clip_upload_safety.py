"""Pure policy for sustained HTTP 406 protection; no network or storage access."""

import datetime as dt


LONG_406_SECONDS = 3 * 3600
MAX_FAILURE_GAP_SECONDS = 30 * 60
SLOW_SECONDS = 24 * 3600
SLOW_INTERVAL_SECONDS = 10 * 60


def observe(previous, event, status, now):
    state = dict(previous)
    alert = None
    if status == 406 and not state.get('pausedAt'):
        if state.get('slowUntil', 0) > now:
            state.update(pausedAt=now, pauseReason='HTTP 406 during slow mode')
            alert = 'paused'
        else:
            last = state.get('last406At')
            if last is None or now - last > MAX_FAILURE_GAP_SECONDS:
                state.update(first406At=now, failures=0)
            state.update(last406At=now, failures=state.get('failures', 0) + 1)
            if now - state['first406At'] >= LONG_406_SECONDS:
                state.update(triggeredAt=now, slowUntil=now + SLOW_SECONDS)
                alert = 'slow'
    elif event in ('archive_complete', 'upload_failed', 'preupload_failed') and status != 406:
        for key in ('first406At', 'last406At', 'failures'):
            state.pop(key, None)
    return state, alert


def activate_slow(previous, now, note):
    if previous.get('pausedAt'):
        raise ValueError('Uploads are paused; use the manual resume command after investigation')
    if previous.get('slowUntil', 0) > now:
        return dict(previous), None
    return {**previous, 'triggeredAt': now, 'slowUntil': now + SLOW_SECONDS,
            'activationNote': note}, 'slow'


def resume(previous, now, note):
    if not previous.get('pausedAt'):
        return dict(previous)
    return {'slowUntil': now + SLOW_SECONDS, 'resumedAt': now, 'resumeNote': note}


def notification_text(account, kind, state):
    def china(value):
        return dt.datetime.fromtimestamp(value, dt.timezone(dt.timedelta(hours=8))).strftime('%m-%d %H:%M:%S')
    if kind == 'paused':
        action = ('慢速模式下再次出现 HTTP 406，**已暂停该账号全部自动投稿，等待人工处理**。'
                  '\n> 不会到时自动恢复；排查后使用投稿队列的 resume 命令恢复。')
    else:
        action = ('已识别三小时级连续 HTTP 406，**进入 24 小时慢速模式：每十分钟最多开始一条投稿**。'
                  f'\n> 慢速截止：{china(state["slowUntil"])}（北京时间）。'
                  '\n> 期间再次 406 将暂停全部自动投稿，等待人工处理。')
    evidence = (f'\n> 连续失败：{china(state["first406At"])}～{china(state["last406At"])}，'
                f'{state.get("failures", 0)} 次。') if state.get('first406At') is not None else ''
    note = f'\n> 原因：{state["activationNote"]}' if state.get('activationNote') else ''
    return f'## B站投稿异常保护\n> 账号 `{account}`\n> {action}{evidence}{note}'
