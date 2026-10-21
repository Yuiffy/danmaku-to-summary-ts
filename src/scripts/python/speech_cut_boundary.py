"""Choose conservative outward cut handles from bounded VAD and original-mix RMS.

No model, media, registry or publication IO. ASR is an anchor, never an acoustic
endpoint. A continuous phrase beyond the bounded search returns needs_review.
Times are absolute source seconds; envelope values are dBFS on equal frames.
"""
from dataclasses import dataclass
import math


@dataclass(frozen=True)
class BoundaryDecision:
    cut: float
    status: str
    method: str
    speech_edge: float | None = None


def refine_boundary(*, original, side, anchor, speech, envelope_start, rms_db,
                    frame_seconds=.01, lower=None, upper=None,
                    max_shift=2., padding=.16, minimum_pause=.08):
    values = [original, anchor, envelope_start, frame_seconds, max_shift, padding, minimum_pause]
    if side not in ('start', 'end') or any(not math.isfinite(v) for v in values):
        raise ValueError('invalid speech boundary request')
    if frame_seconds <= 0 or max_shift <= 0 or padding < 0 or minimum_pause <= 0:
        raise ValueError('invalid speech boundary policy')
    if not rms_db or any(not math.isfinite(v) for v in rms_db):
        raise ValueError('missing original-mix RMS evidence')
    if any(v is not None and not math.isfinite(v) for v in (lower, upper)):
        raise ValueError('nonfinite protected boundary limit')
    envelope_end = envelope_start + len(rms_db)*frame_seconds
    lo = max(envelope_start, original-max_shift, lower if lower is not None else -math.inf)
    hi = min(envelope_end, original+max_shift, upper if upper is not None else math.inf)
    if not lo <= original <= hi:
        raise ValueError('protected boundary limits exclude the original cut')
    intervals = []
    for start, end in sorted(speech):
        if not all(math.isfinite(v) for v in (start, end)) or start >= end:
            raise ValueError('invalid speech evidence interval')
        if intervals and start-intervals[-1][1] < minimum_pause:
            intervals[-1][1] = max(end, intervals[-1][1])
        else:
            intervals.append([start, end])
    # Match the word's acoustic neighborhood, allowing small ASR/VAD disagreement.
    matches = [(a,b) for a,b in intervals if a-.22 <= anchor <= b+.22]
    if matches:
        start, end = min(matches, key=lambda ab: min(abs(anchor-ab[0]), abs(anchor-ab[1])))
        if side == 'end':
            following = next((a for a,b in intervals if a >= end+minimum_pause-.001), hi+padding)
            desired = max(original, end+padding)
            ceiling = min(hi, following-.035)
            if end+.035 > ceiling or ceiling < original or end >= envelope_end-.03:
                return BoundaryDecision(original, 'needs_review', 'continuous_speech_or_no_tail_room', end)
            cut = min(desired, ceiling)
        else:
            previous = max((b for a,b in intervals if b <= start-minimum_pause+.001), default=lo-padding)
            desired = min(original, start-padding)
            floor = max(lo, previous+.035)
            if start-.035 < floor or floor > original or start <= envelope_start+.03:
                return BoundaryDecision(original, 'needs_review', 'continuous_speech_or_no_head_room', start)
            cut = max(desired, floor)
        return BoundaryDecision(round(cut, 3), 'passed', 'local_vad_with_breathing_handle', end if side=='end' else start)
    # A low-energy pause is a fallback only when VAD also reports no speech there.
    direction = 1 if side=='end' else -1
    candidates = [original+direction*i*frame_seconds for i in range(1, int(max_shift/frame_seconds)+1)]
    reference = sorted(rms_db)[len(rms_db)//2]
    threshold = min(-34., reference-8.)
    width = max(1, math.ceil(minimum_pause/frame_seconds))
    for at in candidates:
        if at < lo or at > hi:
            continue
        if (side == 'end' and at < anchor+.035) or (side == 'start' and at > anchor-.035):
            continue
        index = int((at-envelope_start)/frame_seconds)
        left, right = (max(0,index-width),index) if side=='end' else (index,min(len(rms_db),index+width))
        if right-left < width or max(rms_db[left:right]) > threshold:
            continue
        if any(a < envelope_start+right*frame_seconds and b > envelope_start+left*frame_seconds for a,b in intervals):
            continue
        return BoundaryDecision(round(at,3), 'passed', 'vad_free_low_energy_pause')
    return BoundaryDecision(original, 'needs_review', 'no_acoustic_endpoint')
