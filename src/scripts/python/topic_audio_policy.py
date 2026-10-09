"""Pure local transcript-consistency checks, not forced alignment or identity proof."""
from difflib import SequenceMatcher
import re


def normalized(text):
    return ''.join(c for c in str(text).lower() if c.isalnum())


def check_alignment(references, transcript, hotwords):
    # Canonical names cannot supply the alignment evidence being checked.
    def ordinary(text):
        value = normalized(text)
        for name in sorted(hotwords, key=len, reverse=True):
            value = value.replace(normalized(name), '')
        return value
    text = ordinary(transcript)
    matches, eligible, consumed = [], 0, 0
    for cue in references:
        query = ordinary(cue['text'])
        if len(query) < 6 or len(set(query)) < 4 or len(query) > 100:
            continue
        eligible += 1
        # Match whole ordinary cues in order, without reusing transcript characters.
        best = (0, 0, 0)
        for start in range(consumed, len(text)):
            for size in range(max(6, len(query)-3), len(query)+4):
                fragment = text[start:start+size]
                if len(fragment) < 6:
                    continue
                score = SequenceMatcher(None, query, fragment, autojunk=False).ratio()
                if score > best[0]:
                    best = (score, start, start+len(fragment))
        if best[0] >= .72:
            matches.append({'cueId': cue['id'], 'sourceText': cue['text'], 'score': round(best[0], 4),
                            'transcriptStart': best[1], 'transcriptEnd': best[2]})
            consumed = best[2]
    status = 'aligned' if len(matches) >= 2 else 'inconclusive' if eligible < 2 else 'mismatch'
    return {'status': status, 'matches': matches, 'eligibleReferences': eligible,
            'method': 'ordered_ordinary_context', 'wordAlignmentVerified': False}


def decode_window(window, samples, vad, decode, hotwords):
    intervals = vad(samples)
    row = {k: window[k] for k in ('id', 'hitIds', 'start', 'end')}
    row.update(vad=intervals, alignment={'matches': [], 'wordAlignmentVerified': False})
    if not intervals:
        return dict(row, status='no_speech', unprompted=None, biased=None)
    plain = decode(samples, [])
    plain_text = re.sub(r'<\|[^|]+\|>', '', str(plain.get('text', ''))).strip()
    if not plain_text or len(plain_text) > 8000:
        raise ValueError('unprompted decoder output missing or too large')
    alignment = check_alignment(window['references'], plain_text, hotwords)
    row.update(status=alignment['status'], alignment=alignment,
               unprompted={'text': plain_text, 'prompted': False, 'hotwords': [], 'timingPrecision': 'window'}, biased=None)
    if alignment['status'] == 'aligned':
        biased = decode(samples, list(hotwords))
        text = re.sub(r'<\|[^|]+\|>', '', str(biased.get('text', ''))).strip()
        if not text or len(text) > 8000:
            raise ValueError('biased decoder output missing or too large')
        row['biased'] = {'text': text, 'prompted': True, 'hotwords': list(hotwords), 'timingPrecision': 'window'}
    return row
