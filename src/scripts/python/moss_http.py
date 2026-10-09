"""Bounded vLLM transcription transport; preserve independent overlapping turns."""
from __future__ import annotations

import math
import json
from pathlib import Path
import re
import time


def read_transcript_stream(lines, duration, token_limit, deadline=None):
    """Require EOS and token accounting; non-stream diarized_json omits both."""
    parts, reasons, tokens, done = [], [], None, False
    for line in lines:
        if deadline is not None and time.monotonic() > deadline:
            raise TimeoutError('MOSS HTTP inference exceeded request_timeout_s')
        if isinstance(line, bytes):
            line = line.decode('utf-8')
        if not line or line.startswith(':'):
            continue
        if not line.startswith('data: '):
            raise ValueError('Unexpected MOSS stream frame')
        content = line[6:]
        if content == '[DONE]':
            done = True
            break
        event = json.loads(content)
        if 'error' in event:
            raise RuntimeError(f'MOSS stream error: {str(event["error"])[:1200]}')
        for choice in event.get('choices', []):
            parts.append(choice.get('delta', {}).get('content') or '')
            if choice.get('finish_reason') is not None:
                reasons.append(choice['finish_reason'])
        if event.get('usage'):
            tokens = event['usage'].get('completion_tokens')
    if not done or reasons != ['stop'] or tokens is None or not 0 < int(tokens) < token_limit:
        raise ValueError('MOSS stream incomplete or output reached its token limit')
    raw = ''.join(parts).strip()
    # Match the entire canonical transcript, including every ending timestamp.
    # A partially parsed tail must never silently become a successful recording.
    pattern = re.compile(r'\s*\[([0-9.]{1,32})\]\s*\[(S[0-9]{1,15})\](.*?)\[([0-9.]{1,32})\]', re.S)
    rows, offset = [], 0
    while offset < len(raw):
        match = pattern.match(raw, offset)
        if match is None:
            raise ValueError('MOSS output contains an incomplete or invalid diarized turn')
        start, speaker, text, end = match.groups()
        rows.append({'start': float(start), 'end': float(end), 'speaker': speaker, 'text': text})
        offset = match.end()
    return validate_response({'segments': rows, 'usage': {'completion_tokens': tokens}}, duration, token_limit)


def validate_response(data, duration, token_limit):
    if not isinstance(data, dict):
        raise ValueError('MOSS HTTP response must be an object')
    if data.get('finish_reason') == 'length':
        raise ValueError('MOSS HTTP output reached its token limit')
    usage = data.get('usage') or {}
    tokens = usage.get('completion_tokens', usage.get('output_tokens'))
    if tokens is not None and int(tokens) >= token_limit:
        raise ValueError('MOSS HTTP output reached its token limit')
    rows = data.get('segments')
    if not isinstance(rows, list):
        raise ValueError('MOSS HTTP response has no diarized segments')
    result = []
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError('MOSS HTTP segment must be an object')
        start, end = float(row['start']), float(row['end'])
        text, speaker = row.get('text'), row.get('speaker')
        if (not math.isfinite(start) or not math.isfinite(end) or
                start < 0 or start >= duration or end <= start or end > duration + 0.5 or
                not isinstance(text, str) or not text.strip() or
                not isinstance(speaker, str) or not re.fullmatch(r'S\d+', speaker)):
            raise ValueError('MOSS HTTP segment has invalid time, text or anonymous speaker')
        result.append({'start': start, 'end': min(end, duration),
                       'speaker': speaker, 'text': text.strip()})
    if not result and str(data.get('text') or '').strip():
        raise ValueError('MOSS HTTP returned text without speaker intervals')
    # Never flatten overlap or propagate one speaker to another simultaneous row.
    return {'segments': result, 'generated_tokens': int(tokens) if tokens is not None else None}


def transcribe_http(audio_path, payload, token_limit, duration):
    import requests

    base_url = str(payload['base_url']).rstrip('/')
    timeout = float(payload.get('request_timeout_s', 600))
    if not math.isfinite(timeout) or timeout <= 0:
        raise ValueError('MOSS HTTP request_timeout_s must be positive')
    deadline = time.monotonic() + timeout
    with Path(audio_path).open('rb') as stream:
        response = requests.post(base_url + '/audio/transcriptions',
            files={'file': (Path(audio_path).name, stream, 'audio/wav')},
            data={'model': payload.get('served_model_name', 'moss-transcribe-diarize'),
                  'response_format': 'json', 'temperature': '0', 'stream': 'true',
                  'stream_include_usage': 'true', 'max_completion_tokens': str(token_limit)},
            stream=True, timeout=(min(10, timeout), timeout))
    try:
        if not response.ok:
            # No retry with another format: that would repeat a full inference.
            raise RuntimeError(f'MOSS HTTP {response.status_code}: {response.text[:1200]}')
        return read_transcript_stream(response.iter_lines(), duration, token_limit, deadline)
    finally:
        response.close()
