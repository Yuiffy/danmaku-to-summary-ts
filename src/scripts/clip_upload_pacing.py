"""Account-wide real upload admission and telemetry, without availability probes."""

import argparse
import asyncio
from contextlib import closing
import datetime as dt
import json
from pathlib import Path
import re
import sqlite3
import time
try:
    from . import clip_upload_safety as safety
except ImportError:
    import clip_upload_safety as safety


WINDOW_SECONDS = 300
WINDOW_LIMIT = 5
HTTP_406_WAIT_SECONDS = 600
DATABASE_NAME = 'clip_upload_pacing.sqlite3'
DEFAULT_DATABASE = Path(__file__).resolve().parents[2] / 'data' / 'runtime' / DATABASE_NAME


def admission_delay(starts, now, cooldown_until=0):
    """Use an open lower boundary, with a one-second scheduling buffer."""
    recent = sorted(at for at in starts if at > now - WINDOW_SECONDS)
    window_delay = recent[-WINDOW_LIMIT] + WINDOW_SECONDS + 1 - now if len(recent) >= WINDOW_LIMIT else 0
    return max(0, window_delay, cooldown_until - now)


def http_status(error):
    for key in ('status', 'status_code', 'code'):
        value = getattr(error, key, None)
        if type(value) is int and 400 <= value <= 599:
            return value
    return 406 if re.search(r'(?<!\d)406(?!\d)', str(error)) else None


class PreuploadRateLimited(RuntimeError):
    """A rejected initialization cannot have created a submitted archive."""


class UploadPaused(RuntimeError):
    """Manual intervention is required; waiting or restarting cannot release it."""


class UploadPacing:
    def __init__(self, account_id, database=DEFAULT_DATABASE, *, clock=time.time,
                 sleep=asyncio.sleep, emit=print):
        self.account_id = str(account_id)
        self.database = Path(database)
        self.clock, self.sleep, self.emit = clock, sleep, emit

    def _connect(self):
        self.database.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.database, timeout=10)
        db.execute('CREATE TABLE IF NOT EXISTS upload_events ('
                   'id INTEGER PRIMARY KEY, account_id TEXT NOT NULL, at REAL NOT NULL, '
                   'event TEXT NOT NULL, stage TEXT NOT NULL, part_index INTEGER, http_status INTEGER)')
        db.execute('CREATE INDEX IF NOT EXISTS upload_events_account_time '
                   'ON upload_events(account_id, at)')
        db.execute('CREATE TABLE IF NOT EXISTS upload_cooldowns ('
                   'account_id TEXT PRIMARY KEY, until_at REAL NOT NULL)')
        db.execute('CREATE TABLE IF NOT EXISTS upload_safety ('
                   'account_id TEXT PRIMARY KEY, state_json TEXT NOT NULL)')
        db.execute('CREATE TABLE IF NOT EXISTS upload_alerts ('
                   'id INTEGER PRIMARY KEY, account_id TEXT NOT NULL, kind TEXT NOT NULL, '
                   'at REAL NOT NULL, state_json TEXT NOT NULL, next_attempt REAL NOT NULL DEFAULT 0, '
                   'lease_until REAL NOT NULL DEFAULT 0, sent_at REAL, error TEXT)')
        db.commit()
        return db

    def _log(self, event, now, **fields):
        self.emit('[UPLOAD_REQUEST] ' + json.dumps({
            'event': event, 'at': dt.datetime.fromtimestamp(now, dt.timezone.utc).isoformat(),
            'accountId': self.account_id, **fields}, ensure_ascii=False))

    def reserve(self, part_index):
        """Atomically reserve a real initialization across child processes."""
        with closing(self._connect()) as db, db:
            db.execute('BEGIN IMMEDIATE')
            now = self.clock()
            starts = [r[0] for r in db.execute(
                "SELECT at FROM upload_events WHERE account_id=? AND event='preupload_start' AND at>?",
                (self.account_id, now - 3600))]
            row = db.execute('SELECT until_at FROM upload_cooldowns WHERE account_id=?',
                             (self.account_id,)).fetchone()
            delay = admission_delay(starts, now, row[0] if row else 0)
            state = self._state(db)
            if state.get('pausedAt'):
                self.emit('[UPLOAD_PAUSED] HTTP 406 during slow mode; manual intervention required')
                raise UploadPaused('Account uploads paused for manual intervention')
            if part_index == 1 and state.get('slowUntil', 0) > now:
                last = db.execute("SELECT MAX(at) FROM upload_events WHERE account_id=? "
                                  "AND event='preupload_start' AND part_index=1", (self.account_id,)).fetchone()[0]
                if last is not None:
                    delay = max(delay, last + safety.SLOW_INTERVAL_SECONDS - now)
            if delay > 0:
                return delay
            db.execute('INSERT INTO upload_events(account_id,at,event,stage,part_index) VALUES(?,?,?,?,?)',
                       (self.account_id, now, 'preupload_start', 'preupload', part_index))
            counts = {str(seconds): sum(at > now-seconds for at in starts)+1
                      for seconds in (60, 300, 900, 3600)}
        self._log('preupload_start', now, stage='preupload', partIndex=part_index,
                  windowCounts=counts)
        return 0

    async def acquire(self, part_index):
        while True:
            delay = self.reserve(part_index)
            if delay <= 0:
                return
            self._log('wait', self.clock(), partIndex=part_index, waitSeconds=round(delay, 3))
            # Yield regularly without sending network probes.
            remaining = delay
            while remaining > 0:
                step = min(remaining, 30)
                await self.sleep(step)
                remaining -= step

    def record(self, event, stage, status=None, part_index=None):
        with closing(self._connect()) as db, db:
            db.execute('BEGIN IMMEDIATE')
            now = self.clock()
            db.execute('INSERT INTO upload_events(account_id,at,event,stage,part_index,http_status) '
                       'VALUES(?,?,?,?,?,?)', (self.account_id, now, event, stage, part_index, status))
            state, alert = safety.observe(self._state(db), event, status, now)
            self._save_state(db, state, alert, now)
            if status == 406:
                db.execute('INSERT INTO upload_cooldowns(account_id,until_at) VALUES(?,?) '
                           'ON CONFLICT(account_id) DO UPDATE SET until_at=MAX(until_at, excluded.until_at)',
                           (self.account_id, now+HTTP_406_WAIT_SECONDS))
        self._log(event, now, stage=stage, httpStatus=status, partIndex=part_index,
                  **({'cooldownSeconds': HTTP_406_WAIT_SECONDS} if status == 406 else {}))


    def _state(self, db):
        row = db.execute('SELECT state_json FROM upload_safety WHERE account_id=?',
                         (self.account_id,)).fetchone()
        return json.loads(row[0]) if row else {}

    def _save_state(self, db, state, alert, now):
        encoded = json.dumps(state, ensure_ascii=False)
        db.execute('INSERT INTO upload_safety VALUES(?,?) ON CONFLICT(account_id) '
                   'DO UPDATE SET state_json=excluded.state_json', (self.account_id, encoded))
        if alert:
            db.execute('INSERT INTO upload_alerts(account_id,kind,at,state_json) VALUES(?,?,?,?)',
                       (self.account_id, alert, now, encoded))

    def activate_slow(self, note):
        if not str(note).strip():
            raise ValueError('A reason is required to activate protection')
        with closing(self._connect()) as db, db:
            db.execute('BEGIN IMMEDIATE')
            now = self.clock()
            state, alert = safety.activate_slow(self._state(db), now, note)
            self._save_state(db, state, alert, now)
        return state

    def resume(self, note):
        if not self.database.exists():
            return {}
        with closing(self._connect()) as db, db:
            db.execute('BEGIN IMMEDIATE')
            state = safety.resume(self._state(db), self.clock(), note)
            self._save_state(db, state, None, self.clock())
        return state

    def deliver_alerts(self, send):
        """Lease a durable alert, retry delivery failures without releasing protection."""
        if not self.database.exists():
            return
        for _ in range(10):
            now = self.clock()
            with closing(self._connect()) as db, db:
                db.execute('BEGIN IMMEDIATE')
                row = db.execute('SELECT id,kind,state_json FROM upload_alerts WHERE account_id=? '
                                 'AND sent_at IS NULL AND next_attempt<=? AND lease_until<=? ORDER BY id LIMIT 1',
                                 (self.account_id, now, now)).fetchone()
                if row is None:
                    return
                db.execute('UPDATE upload_alerts SET lease_until=? WHERE id=?', (now+60, row[0]))
            error = None
            try:
                if not send(safety.notification_text(self.account_id, row[1], json.loads(row[2]))):
                    error = 'NotificationUnavailable'
            except Exception as failure:
                # Exception URLs can contain a webhook token; retain only its type.
                error = type(failure).__name__
            with closing(self._connect()) as db, db:
                db.execute('UPDATE upload_alerts SET sent_at=?,error=?,next_attempt=?,lease_until=0 WHERE id=?',
                           (None if error else self.clock(), error, self.clock()+300, row[0]))
            if error:
                self.emit(f'[UPLOAD_ALERT] delivery failed: {error}; retry in 300s')


def protection_status(account_id, database=DEFAULT_DATABASE, now=None):
    """Inspect safety and the next archive start without creating/migrating a database."""
    database = Path(database).resolve()
    result = {'paused': False, 'slow': False, 'waitSeconds': 0, 'state': {}}
    if not database.exists():
        return result
    current = time.time() if now is None else now
    with closing(sqlite3.connect(database.as_uri()+'?mode=ro', uri=True, timeout=10)) as db:
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if 'upload_safety' not in tables:
            return result
        row = db.execute('SELECT state_json FROM upload_safety WHERE account_id=?', (str(account_id),)).fetchone()
        state = json.loads(row[0]) if row else {}
        last = db.execute("SELECT MAX(at) FROM upload_events WHERE account_id=? "
                          "AND event='preupload_start' AND part_index=1", (str(account_id),)).fetchone()[0]
    slow = state.get('slowUntil', 0) > current
    return {'paused': bool(state.get('pausedAt')), 'slow': slow, 'state': state,
            'waitSeconds': max(0, last+safety.SLOW_INTERVAL_SECONDS-current) if slow and last is not None else 0}


def cooldown_remaining(account_id, database=DEFAULT_DATABASE, now=None):
    """Read-only worker gate; do not create runtime files during queue inspection."""
    database = Path(database).resolve()
    if not database.exists():
        return 0
    with closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=10)) as db:
        row = db.execute('SELECT until_at FROM upload_cooldowns WHERE account_id=?',
                         (str(account_id),)).fetchone()
    return max(0, row[0]-(time.time() if now is None else now)) if row else 0


def paced_uploader_type(base, pacing, pages, before_submit=None):
    """Pace real initialization and stop internal chunk-406 retries; retain SDK IO."""
    class PacedUploader(base):
        def dispatch(self, name, data=None):
            # The SDK converts chunk HTTP failures to {ok: False} and retries
            # internally. Observe its status event without logging the payload.
            if name == 'CHUNK_FAILED' and http_status(str((data or {}).get('info', ''))) == 406:
                self._chunk_http406 = True
            return super().dispatch(name, data)

        async def _upload_chunk(self, *args, **kwargs):
            result = await super()._upload_chunk(*args, **kwargs)
            if getattr(self, '_chunk_http406', False):
                raise RuntimeError('chunk HTTP 406; stop SDK internal retry')
            return result

        async def _preupload(self, page):
            index = next(i+1 for i, candidate in enumerate(pages) if candidate is page)
            await pacing.acquire(index)
            if before_submit:
                before_submit()
            try:
                result = await super()._preupload(page)
            except Exception as error:
                status = http_status(error)
                pacing.record('preupload_failed', 'preupload', status, index)
                if status == 406:
                    pacing.emit('[RATE_LIMIT_406] stage=preupload; account cooldown 600s')
                    raise PreuploadRateLimited('preupload HTTP 406; account cooldown 600s') from error
                raise
            pacing.record('preupload_ready', 'preupload', 200, index)
            return result
    return PacedUploader


def print_statistics(database, hours=24, account_id=None):
    cutoff = time.time()-hours*3600
    if not Path(database).exists():
        print(json.dumps({'hours': hours, 'events': 0, 'accounts': []}))
        return
    with closing(sqlite3.connect(Path(database).resolve().as_uri()+'?mode=ro', uri=True)) as db:
        where = 'at>=?' + (' AND account_id=?' if account_id is not None else '')
        params = (cutoff, str(account_id)) if account_id is not None else (cutoff,)
        counts = db.execute('SELECT account_id,event,stage,http_status,COUNT(*) FROM upload_events '
                            f'WHERE {where} GROUP BY account_id,event,stage,http_status', params).fetchall()
        recent = db.execute('SELECT account_id,at,event,stage,part_index,http_status FROM upload_events '
                            f'WHERE {where} ORDER BY at DESC LIMIT 30', params).fetchall()
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        protected = db.execute('SELECT account_id FROM upload_safety').fetchall() if 'upload_safety' in tables else []
    accounts = sorted({row[0] for row in counts} | {row[0] for row in protected})
    if account_id is not None and str(account_id) not in accounts:
        accounts.append(str(account_id))
    print(json.dumps({'hours': hours, 'windowSeconds': WINDOW_SECONDS, 'windowLimit': WINDOW_LIMIT,
        'protection': {account: protection_status(account, database) for account in accounts},
        'counts': [dict(zip(('accountId','event','stage','httpStatus','count'), r)) for r in counts],
        'recent': [dict(zip(('accountId','timestamp','event','stage','partIndex','httpStatus'), r))
                   for r in recent]}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Read upload request pacing statistics without platform requests')
    parser.add_argument('--database', type=Path, default=DEFAULT_DATABASE)
    parser.add_argument('--hours', type=float, default=24)
    parser.add_argument('--account')
    parser.add_argument('--activate-slow', action='store_true', help='Protect a confirmed historical long-406 incident')
    parser.add_argument('--note', default='')
    options = parser.parse_args()
    if options.activate_slow:
        if not options.account or not options.note.strip():
            parser.error('--activate-slow requires --account and --note')
        UploadPacing(options.account, options.database).activate_slow(options.note)
    print_statistics(options.database, options.hours, options.account)
