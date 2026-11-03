"""Independent upload validation for conservative, evidence-bound silent exits."""
import json
import math
import re
from pathlib import Path


def closing_boundary(review, transcript):
    number = lambda v: not isinstance(v, bool) and isinstance(v, (float, int)) and math.isfinite(v)
    window, samples, frames, context = (review.get(k) or {} for k in ("window", "samples", "frames", "contextReview"))
    eof = review.get('version') == 3 and review.get('retentionMode') == 'through_recording_end'
    step = 30 if eof else 2
    if ((not eof and review.get("version") != 2) or review.get("timingSource") != "original_closing_context"
            or review.get("sampleSeconds") != step or review.get("resolutionSeconds") != (None if eof else .25)
            or not all(number(window.get(k)) for k in ("start", "end")) or not 0 <= window["start"] < window["end"]
            or not 3 <= len(samples) <= 640 or len(samples) != len(frames)):
        raise ValueError("game original closing context coverage is incomplete")
    indices = [s.get("index") for s in samples]
    if (any(not isinstance(i, int) or isinstance(i, bool) for i in indices)
            or sorted(indices) != list(range(1, len(samples)+1))):
        raise ValueError("game closing context sample identities changed")
    previous = None
    for sample, frame in zip(samples, frames):
        time = sample.get("time")
        if (not number(time) or not window['start'] <= time <= window['end']
                or previous is not None and not 0 < time-previous <= step+.001
                or frame.get("index") != sample["index"] or frame.get("activity") not in ("game", "other", "uncertain")
                or not str(frame.get("description") or "").strip()):
            raise ValueError("game original closing context coverage is incomplete")
        previous = time
    if abs(samples[0]["time"]-window["start"]) > .001 or abs(samples[-1]["time"]-(window["end"]-(.1 if eof else 0))) > .001:
        raise ValueError("game original closing context window changed")
    if eof:
        if (not number(review.get('sourceDuration')) or window['end'] != review['sourceDuration']
                or window['end']-window['start'] > 3600 or not any(f['activity'] == 'game' for f in frames)
                or context.get('decision') != 'keep' or not str(context.get('reason') or '').strip()
                or any(context.get(k) is not True for k in ('ownTargetGame', 'allPossibleHandlingRetained', 'retainedContentAllowed', 'recordingEndRetained'))
                or 'laterContextUnrelated' not in context or context['laterContextUnrelated'] is not None
                or 'retainedTail' not in context or context['retainedTail'] is not None):
            raise ValueError('complete recording tail has not been independently verified')
        return review['sourceDuration']
    possible = [i for i, f in enumerate(frames) if f["activity"] != "other"]
    last = possible[-1] if possible else -1
    if (not any(f["activity"] == "game" for f in frames) or last < 0 or last+2 >= len(samples)
            or samples[last+1]["time"]-samples[last]["time"] > .251):
        raise ValueError("game original closing context lacks a bounded final transition")
    if (context.get("decision") != "keep" or not str(context.get("reason") or "").strip()
            or any(context.get(k) is not True for k in ("ownTargetGame", "allPossibleHandlingRetained", "laterContextUnrelated", "retainedContentAllowed"))
            or "retainedTail" not in context):
        raise ValueError("game original closing context permits later handling")
    expected = samples[last+1]["time"]
    tail = context["retainedTail"]
    if tail is not None:
        index = tail.get("transcriptIndex")
        if not isinstance(index, int) or isinstance(index, bool) or not 1 <= index <= len(transcript):
            raise ValueError("game retained closing speech is not bound to independent ASR")
        row = transcript[index-1]
        if tail != dict(transcriptIndex=index, **{k: row[k] for k in ("start", "end", "text")}) or not window["start"] <= row["start"] < row["end"] <= window["end"]:
            raise ValueError("game retained closing speech is not bound to independent ASR")
        expected = max(expected, row["end"])
    if expected > window["end"]-2:
        raise ValueError("game closing context does not establish unrelated aftermath")
    return expected


def validate_closing_context(verification, window, excerpt, duration, source, digest, read_audio, check_extraction):
    review = verification.get("endFrameReview") or {}
    identity = {k: source[k] for k in ("mediaPath", "mediaBytes", "mediaMtimeNs")}
    evidence = review.get("localAudioEvidence") or {}; primary = evidence.get("primary") or {}
    eof = review.get('version') == 3 and review.get('retentionMode') == 'through_recording_end'
    if (verification.get("version") != 4 or verification.get("protocolVersion", 0) < 14
            or verification.get("evidenceMethod") != "independent_local_asr" or review.get("source") != identity
            or review.get("window") != window or not 0 <= window["start"] < window["end"] <= duration
            or evidence.get("version") != 1 or evidence.get("method") != "independent_local_asr"
            or primary.get("start") != window["start"] or primary.get("end") != window["end"]
            or not str(primary.get("audioPath") or "").strip()
            or not isinstance(evidence.get("retranscriptions"), list)):
        raise ValueError("game original closing context source or audio changed")
    if eof and (review.get('sourceDuration') != duration or window['end'] != duration):
        raise ValueError('retained recording end differs from complete source duration')
    transcript = read_audio(primary, source)
    for bundle in evidence["retranscriptions"]:
        read_audio(bundle, source)
        if bundle["start"] < window["start"] or bundle["end"] > window["end"]:
            raise ValueError("game closing retranscription exceeds original audio")
    expected = closing_boundary(review, transcript)
    samples, frames = review["samples"], review["frames"]
    def read_response(file, sha):
        if digest(file) != sha:
            raise ValueError("game closing context assessment changed")
        raw = json.loads(Path(file).read_text(encoding="utf-8-sig"))
        parsed = json.loads(re.sub(r"\s*```$", "", re.sub(r"^```(?:json)?\s*", "", raw["text"].strip())))
        return raw, parsed
    binding = lambda batch: [{k: s[k] for k in ("index", "time", "sha256")} for s in batch]
    for sample in samples:
        receipt_path, _ = check_extraction(sample["path"], source, sample["time"])
        if (digest(sample["path"]) != sample.get("sha256") or str(receipt_path) != sample.get("receiptPath")
                or digest(receipt_path) != sample.get("receiptSha256")):
            raise ValueError("game original closing image evidence changed")
    covered = set()
    for batch in review.get("batches") or []:
        ids = batch.get("indices") or []
        if not 1 <= len(ids) <= 8 or len(set(ids)) != len(ids) or covered.intersection(ids):
            raise ValueError("game closing image assessment coverage changed")
        selected = [next((s for s in samples if s["index"] == i), None) for i in ids]
        raw, parsed = read_response(batch["responsePath"], batch["responseSha256"])
        if (None in selected or raw.get("requestBinding") != dict(version=1, source=identity, samples=binding(selected))
                or parsed.get("frames") != [next(f for f in frames if f["index"] == i) for i in ids]
                or not str(parsed.get("reason") or "").strip()):
            raise ValueError("game accepted closing images differ from original assessment")
        covered.update(ids)
    if len(covered) != len(samples):
        raise ValueError("game closing image assessments are incomplete")
    context = review["contextReview"]
    raw, parsed = read_response(context["responsePath"], context["responseSha256"])
    keys = ("decision", "reason", "ownTargetGame", "allPossibleHandlingRetained", "laterContextUnrelated", "retainedContentAllowed", "retainedTail")
    expected_binding = dict(version=2 if eof else 1, source=identity, window=window, localAudioEvidence=evidence, samples=binding(samples))
    if eof:
        expected_binding.update(retentionMode=review['retentionMode'], sourceDuration=duration)
        keys += ('recordingEndRetained',)
    if (raw.get("requestBinding") != expected_binding
            or any(parsed.get(k) != context.get(k) for k in keys)):
        raise ValueError("game accepted closing context differs from original assessment")
    observation = dict(index=2, heardWords=None, timingSource="original_closing_context")
    boundary = verification["boundaryReview"]
    if (excerpt.get("decision") != "keep" or excerpt.get("observed") is not True or excerpt.get("heardWords") is not None
            or excerpt.get("timingSource") != review["timingSource"] or excerpt.get("boundaryAnchor") != "after_retained_context"
            or not str(excerpt.get("reason") or "").strip() or "quoteSource" in excerpt or "independentlyTranscribedQuote" in excerpt
            or verification["audioObservations"][1] != observation or boundary["audioObservations"][1] != observation
            or boundary.get("endFrameReview") != review or "spokenEnd" in boundary
            or any(not isinstance(v, (int, float)) or not math.isfinite(v) or abs(v-expected) > .001
                for v in (review.get("end"), verification.get("end"), boundary.get("end"), excerpt.get("seconds", -1)+window["start"]))):
        raise ValueError("game accepted closing context envelope changed")
    return expected
