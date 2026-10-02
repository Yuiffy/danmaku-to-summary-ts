"""Validate complete game coverage and bind media, external subtitles and public copy."""
from __future__ import annotations
import hashlib
import json
import math
from pathlib import Path
try:
    from .audit_bilibili_clip import parse_srt
except ImportError:
    from audit_bilibili_clip import parse_srt

TYPE = "stream_game_submission"
def file_digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def content_digest(metadata):
    keys = ("kind", "gameId", "sourceSnapshot", "planSignature", "coverage", "visualTimeline", "activities", "window", "copy", "upload", "output", "coverSha256")
    return hashlib.sha256(json.dumps({k: metadata.get(k) for k in keys}, sort_keys=True,
                                     ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()


def included_ranges(event):
    ranges, start = [], event["start"]
    for excluded in sorted(event.get("excludedRanges") or [], key=lambda x: x["start"]):
        if not event["start"] <= excluded["start"] < excluded["end"] <= event["end"]:
            raise ValueError("game exclusion exceeds gameplay")
        if excluded["start"] > start:
            ranges.append((start, excluded["start"]))
        start = max(start, excluded["end"])
    if start < event["end"]:
        ranges.append((start, event["end"]))
    return ranges


def check_closing_frames(verification, duration):
    """Recompute the visible closing transition without trusting its saved end."""
    review = verification.get("endFrameReview") or {}
    samples, frames = review.get("samples") or [], review.get("frames") or []
    number = lambda v: not isinstance(v, bool) and isinstance(v, (int, float)) and math.isfinite(v)
    spoken, scan = review.get("spokenEnd"), review.get("scanEnd")
    if (review.get("version") != 1 or review.get("sampleSeconds") != 2 or review.get("resolutionSeconds") != .25
            or not str(review.get("reason") or "").strip() or not number(spoken) or not number(scan)
            or not 0 <= spoken < scan <= duration or scan - spoken < 2 or len(samples) != len(frames) or len(samples) < 2):
        raise ValueError("game original closing frame review is incomplete")
    previous = None
    for i, (sample, frame) in enumerate(zip(samples, frames)):
        time = sample.get("time")
        if (sample.get("index") != i + 1 or frame.get("index") != i + 1 or not number(time)
                or previous is not None and not 0 < time - previous <= 2.001
                or frame.get("activity") not in ("game", "other", "uncertain") or not str(frame.get("description") or "").strip()):
            raise ValueError("game original closing frame coverage is incomplete")
        media = Path(sample.get("path") or "")
        if not media.is_file() or file_digest(media) != sample.get("sha256"):
            raise ValueError("game original closing frame evidence changed")
        previous = time
    if abs(samples[0]["time"] - spoken) > .001 or abs(samples[-1]["time"] - scan) > .001:
        raise ValueError("game original closing frame coverage is incomplete")
    if any(f["activity"] == "uncertain" for f in frames):
        raise ValueError("game original closing frames remain uncertain")
    games = [i for i, frame in enumerate(frames) if frame["activity"] == "game"]
    expected = spoken
    if games:
        last = games[-1]
        if last + 2 >= len(frames):
            raise ValueError("game remains visible at the end of closing evidence")
        if samples[last + 1]["time"] - samples[last]["time"] > .251:
            raise ValueError("game closing transition needs finer original frames")
        expected = samples[last + 1]["time"]
    if (not number(review.get("end")) or abs(review["end"] - expected) > .001
            or abs(verification["end"] - expected) > .001
            or abs(verification["boundaryReview"].get("spokenEnd", -1) - spoken) > .001):
        raise ValueError("game accepted ending differs from original closing frames")
    return spoken


def bind_quote(cues, window, quote):
    normalize = lambda s: "".join(c for c in str(s or "").lower() if c.isalnum())
    text, offsets, previous = "", [], None
    for cue in cues:
        if cue["end"] < window["start"] or cue["start"] > window["end"]:
            continue
        if previous and cue["start"] > previous["end"] + 3:
            text += "|"; offsets.append(None)
        value = normalize(cue["text"])
        text += value; offsets.extend([cue] * len(value)); previous = cue
    at = text.find(quote)
    if at < 0 or text.find(quote, at + 1) >= 0:
        raise ValueError("game original boundary quote is absent or ambiguous")
    first, last = offsets[at], offsets[at + len(quote) - 1]
    return {"start": first["start"], "end": last["end"]}


def check_original_extraction(path, source, time, end=None):
    receipt_path = Path(str(path) + ".complete.json")
    receipt = json.loads(receipt_path.read_text(encoding="utf-8-sig"))
    identity = {k: source[k] for k in ("mediaPath", "mediaBytes", "mediaMtimeNs")}
    args = receipt.get("args") or []
    signature = hashlib.sha256(json.dumps({"args": args, "source": receipt.get("source")},
        ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()
    if (receipt.get("version") != 3 or receipt.get("source") != identity or receipt.get("signature") != signature
            or len(args) < 6 or args[:2] != ["-y", "-ss"] or args[3:5] != ["-i", source["mediaPath"]]
            or not math.isfinite(float(args[2])) or abs(float(args[2]) - time) > .001 or args[-1] != str(path) or receipt.get("sha256") != file_digest(path)):
        raise ValueError("independent game evidence extraction differs from original recording")
    if end is not None and (len(args) != 17 or args[5] != "-t" or not math.isfinite(float(args[6])) or abs(float(args[6]) - (end-time)) > .001
            or args[7:-1] != ["-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "64k"]):
        raise ValueError("independent game audio extraction differs from original window")
    if end is None and args[5:-1] != ["-frames:v", "1", "-vf", "scale=960:-2", "-q:v", "3"]:
        raise ValueError("independent game frame extraction differs from original time")
    return receipt_path, receipt


def read_independent_audio(bundle, source):
    identity = {k: source[k] for k in ("mediaPath", "mediaBytes", "mediaMtimeNs")}
    number = lambda v: not isinstance(v, bool) and isinstance(v, (int, float)) and math.isfinite(v)
    if (bundle.get("version") != 1 or bundle.get("method") != "independent_local_asr" or bundle.get("backend") != "paraformer"
            or bundle.get("source") != identity or not number(bundle.get("start")) or not number(bundle.get("end"))
            or not 0 <= bundle["start"] < bundle["end"] or not str(bundle.get("settingsSignature") or "").strip()):
        raise ValueError("independent game audio provenance is incomplete")
    for path_key, digest_key in (("asrPath", "asrSha256"), ("provenancePath", "provenanceSha256")):
        if file_digest(bundle[path_key]) != bundle.get(digest_key):
            raise ValueError("independent original-audio transcription evidence changed")
    saved = json.loads(Path(bundle["provenancePath"]).read_text(encoding="utf-8-sig"))
    if any(bundle.get(k) != v for k, v in saved.items()):
        raise ValueError("independent game ASR provenance changed")
    receipt_path, receipt = check_original_extraction(bundle["audioPath"], source, bundle["start"], bundle["end"])
    if (str(receipt_path) != bundle.get("receiptPath") or file_digest(receipt_path) != bundle.get("receiptSha256")
            or receipt["sha256"] != bundle.get("audioSha256")):
        raise ValueError("independent game ASR differs from its original audio")
    raw = json.loads(Path(bundle["asrPath"]).read_text(encoding="utf-8-sig"))
    segments, previous, duration = raw.get("segments"), -1, bundle["end"]-bundle["start"]
    if not isinstance(segments, list):
        raise ValueError("independent original-audio ASR has invalid timing")
    rows = []
    for s in segments:
        if (not number(s.get("start")) or not number(s.get("end")) or not 0 <= s["start"] < s["end"] <= duration + .25
                or s["start"] < previous or not str(s.get("text") or "").strip()):
            raise ValueError("independent original-audio ASR has invalid timing")
        previous = s["start"]
        rows.append({"start": bundle["start"]+s["start"], "end": bundle["start"]+min(duration, s["end"]), "text": s["text"]})
    return rows


def check_independent_audio_quote(excerpt, window, quote, expected, source, audio_path, index):
    evidence = excerpt.get("localAudioEvidence") or {}
    primary = evidence.get("primary") or {}
    if (evidence.get("version") != 1 or evidence.get("method") != "independent_local_asr"
            or primary.get("start") != window["start"] or primary.get("end") != window["end"]
            or Path(primary.get("audioPath") or "").resolve() != audio_path.resolve()
            or not isinstance(evidence.get("retranscriptions"), list)):
        raise ValueError("independent boundary is missing its actual original-audio transcription")
    matches = []
    for context_index, bundle in enumerate([primary] + evidence["retranscriptions"]):
        rows = read_independent_audio(bundle, source)
        if bundle["start"] < window["start"] or bundle["end"] > window["end"]:
            raise ValueError("independent re-decoding is outside original boundary excerpt")
        try:
            bound = bind_quote(rows, window, quote)
        except ValueError:
            continue
        anchor = "start" if index == 0 else "end"
        if (bound["start"] > expected["end"]+3 or expected["start"] > bound["end"]+3
                or abs(bound[anchor]-expected[anchor]) > 3):
            raise ValueError("independent audio and source subtitles disagree about boundary time")
        matches.append({"contextIndex": context_index, "quoteSource": bound})
    if not matches:
        raise ValueError("boundary phrase is absent or ambiguous in independent original-audio decode")
    saved = excerpt.get("independentlyTranscribedQuote") or {}
    if saved.get("contextIndex") != matches[0]["contextIndex"] or any(
            abs((saved.get("quoteSource") or {}).get(k, -1000)-matches[0]["quoteSource"][k]) > .001 for k in ("start", "end")):
        raise ValueError("independently transcribed boundary quote differs from original evidence")


def check_boundary_quotes(verification, source_srt, duration, source=None):
    """Bind independently heard quotes; protocol 9 also preserves silent exit visuals."""
    windows = verification.get("audioWindows") or []
    excerpts = verification["boundaryReview"].get("excerptReviews") or []
    if len(windows) != 2 or len(excerpts) != 2:
        raise ValueError("game original boundary quote evidence is incomplete")
    normalize = lambda s: "".join(c for c in str(s or "").lower() if c.isalnum())
    number = lambda v: not isinstance(v, bool) and isinstance(v, (int, float)) and math.isfinite(v)
    cues = parse_srt(source_srt)
    spoken_end = check_closing_frames(verification, duration) if verification.get("protocolVersion", 0) >= 9 else verification["end"]
    for i, (window, excerpt) in enumerate(zip(windows, excerpts)):
        if not all(number(window.get(k)) for k in ("start", "end")) or not 0 <= window["start"] < window["end"] <= duration + .01:
            raise ValueError("game original boundary audio window is invalid")
        quote = normalize(excerpt.get("heardWords"))
        expected_anchor = "before_phrase" if i == 0 else "after_phrase"
        if excerpt.get("decision") != "keep" or excerpt.get("observed") is not True or excerpt.get("boundaryAnchor") != expected_anchor or excerpt.get("timingSource") != "original_transcript_quote" or len(quote) < 4:
            raise ValueError("game original boundary quote was not independently observed")
        if excerpt.get("heardWords") != verification["audioObservations"][i]["heardWords"]:
            raise ValueError("game original boundary quote differs from audio observation")
        expected = bind_quote(cues, window, quote)
        saved = excerpt.get("quoteSource") or {}
        if any(not number(saved.get(k)) or abs(saved[k] - expected[k]) > .001 for k in ("start", "end")) or not window["start"] <= expected["start"] <= expected["end"] <= window["end"]:
            raise ValueError("game original boundary quote timestamp differs from source")
        boundary = expected["start"] if i == 0 else expected["end"]
        accepted = verification["start"] if i == 0 else spoken_end
        if abs(accepted - boundary) > .001 or not number(excerpt.get("seconds")) or abs(excerpt["seconds"] + window["start"] - boundary) > .001:
            raise ValueError("game accepted boundary differs from its original quote")
        if verification.get("version") == 4:
            if not source:
                raise ValueError("independent boundary needs its original recording identity")
            check_independent_audio_quote(excerpt, window, quote, expected, source,
                Path(verification["evidenceDirectory"]) / f"audio-{i+1}.mp3", i)


def check_original_game_frames(verification, source):
    evidence = verification.get("originalFrameEvidence") or []
    times = verification["frameTimes"]
    if len(evidence) != len(times):
        raise ValueError("game original frame provenance is incomplete")
    for i, (frame, time) in enumerate(zip(evidence, times)):
        if frame.get("index") != i+1 or frame.get("time") != time or file_digest(frame["path"]) != frame.get("sha256"):
            raise ValueError("game original frame evidence changed")
        check_original_extraction(frame["path"], source, time)
    for sample in (verification.get("endFrameReview") or {}).get("samples") or []:
        check_original_extraction(sample["path"], source, sample["time"])


def check_source_window(event):
    window = event.get("sourceWindow")
    if not window:
        return
    verification = event.get("verification") or {}
    values = [window.get(k) for k in ("start", "end")]
    if (any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in values)
            or window["start"] != verification.get("start") or window["end"] != verification.get("end")
            or not window["start"] <= event["start"] < event["end"] <= window["end"]):
        raise ValueError("game source window differs from the verified full session")


def chapter_phase_end(event, index):
    chapters = event.get("chapters") or []
    return chapters[index+1]["start"] if index+1 < len(chapters) else (event.get("sourceWindow") or event)["end"]


def check_frame_names(event, source):
    normalize = lambda s: "".join(c for c in str(s or "").lower() if c.isalnum())
    chapters = event.get("chapters") or []
    for index, chapter in enumerate(chapters):
        if chapter.get("nameEvidenceSource") != "original_frame":
            continue
        evidence = chapter.get("frameNameEvidence") or {}
        if (evidence.get("version") != 1 or evidence.get("source") != source or evidence.get("phaseStart") != chapter["start"]
                or evidence.get("publicTitle") != chapter["title"] or evidence.get("label") != chapter.get("nameEvidence")
                or evidence.get("kind") != chapter.get("kind") or file_digest(evidence["responsePath"]) != evidence.get("responseSha256")):
            raise ValueError("game chapter name differs from its original-frame evidence")
        raw = json.loads(Path(evidence["responsePath"]).read_text(encoding="utf-8-sig"))
        text = str(raw.get("text") or "").strip()
        if text.startswith('```'):
            text = text.split('\n', 1)[1].rsplit('```', 1)[0].strip()
        row = json.loads(text)
        if (row.get("supported") is not True or row.get("activity") != "gameplay" or row.get("kind") not in ("boss", "location")
                or row.get("kind") != evidence["kind"] or row.get("label") != evidence["label"]
                or row.get("frameIndex") != evidence.get("selectedFrameIndex") or len(normalize(row["label"])) < 2
                or normalize(row["label"]) not in normalize(chapter["title"])):
            raise ValueError("game chapter name is not a literal original live-game label")
        selected = None
        for i, frame in enumerate(evidence.get("frames") or []):
            if (frame.get("index") != i+1 or not evidence["phaseStart"] <= frame["time"] < evidence["phaseEnd"]
                    or file_digest(frame["path"]) != frame.get("sha256")):
                raise ValueError("game original name frame changed")
            check_original_extraction(frame["path"], source, frame["time"])
            if frame["index"] == evidence["selectedFrameIndex"]:
                selected = frame
        end = chapter_phase_end(event, index)
        if not selected or not chapter["start"] <= selected["time"] < end:
            raise ValueError("game name frame is outside its actual chapter")


def check_editorial_revisions(event, source):
    chapters = event.get("chapters") or []
    for index, chapter in enumerate(chapters):
        evidence = chapter.get("editorialRevision")
        if not evidence:
            continue
        copy = {k: chapter[k] for k in ("title", "description")}
        if (evidence.get("version") != 1 or evidence.get("source") != source or evidence.get("newCopy") != copy
                or evidence.get("phaseStart") != chapter["start"] or not str(evidence.get("rejectionReason") or "").strip()
                or file_digest(evidence["proposalPath"]) != evidence.get("proposalSha256")):
            raise ValueError("game editorial copy differs from its original proposal")
        raw = json.loads(Path(evidence["proposalPath"]).read_text(encoding="utf-8-sig"))
        text = str(raw.get("text") or "").strip()
        if text.startswith('```'):
            text = text.split('\n', 1)[1].rsplit('```', 1)[0].strip()
        row = json.loads(text)
        if any(row.get(k) != v for k, v in copy.items()) or not str(row.get("reason") or "").strip():
            raise ValueError("game editorial proposal differs from reviewed copy")
        frames = evidence.get("frames") or []
        if not frames:
            raise ValueError("game editorial proposal lacks original frames")
        end = chapter_phase_end(event, index)
        for frame in frames:
            if not chapter["start"] <= frame["time"] < end or file_digest(frame["path"]) != frame.get("sha256"):
                raise ValueError("game editorial original frame changed or exceeds chapter")
            check_original_extraction(frame["path"], source, frame["time"])


def check_artifacts(metadata):
    if metadata.get("type") != TYPE or metadata.get("version") != 1 or metadata.get("kind") != "games":
        raise ValueError("invalid game submission")
    coverage = metadata.get("coverage") or {}
    if coverage.get("status") != "complete" or not coverage.get("windows"):
        raise ValueError("game detection coverage is incomplete")
    end = 0
    for window in coverage["windows"]:
        if window.get("status") != "inspected" or abs(window["start"] - end) > .01 or window["end"] <= end:
            raise ValueError("game detection has an uninspected gap")
        end = window["end"]
    if abs(end - coverage["duration"]) > .01:
        raise ValueError("game detection does not cover the full recording")
    visual = metadata.get("visualTimeline") or {}
    if visual.get("status") != "complete" or not visual.get("key") or not 30 <= visual.get("sampleSeconds", 0) <= 120:
        raise ValueError("complete independent game visual timeline is missing")
    next_frame = 1
    for span in visual.get("ranges") or []:
        if span.get("first") != next_frame or span["last"] < span["first"] or span.get("kind") not in ("gameplay", "other", "watching_game"):
            raise ValueError("game visual timeline has a gap or uncertainty")
        next_frame = span["last"] + 1
    if next_frame != visual.get("samples", 0) + 1 or visual.get("samples", 0) < 2:
        raise ValueError("game visual timeline does not cover all samples")
    output, upload = metadata["output"], metadata["upload"]
    if upload.get("externalSubtitles") is not True or upload.get("subtitleLanguage") != "zh-CN":
        raise ValueError("game submission must keep its reviewed external Chinese subtitles")
    if not upload.get("collectionSectionId") or not upload.get("collectionSeasonId"):
        raise ValueError("dedicated game collection is missing")
    if not str(metadata["copy"].get("title") or "").strip() or len(upload.get("prefix", "") + metadata["copy"]["title"]) > 80:
        raise ValueError("invalid game submission title")
    if not str(metadata["copy"].get("description") or "").strip() or len(metadata["copy"]["description"]) > 2000:
        raise ValueError("invalid game description")
    parts = output.get("parts") or []
    if not 1 <= len(parts) <= 100:
        raise ValueError("game submission needs 1–100 Ps")
    events = {e["id"]: e for e in metadata.get("activities") or []}
    if not events:
        raise ValueError("game submission has no verified gameplay")
    previous, by_event = -1, {}
    for part in parts:
        start, end, duration = part["start"], part["end"], part["duration"]
        if any(isinstance(v, bool) or not isinstance(v, (float, int)) or not math.isfinite(v) for v in (start, end, duration)):
            raise ValueError("invalid game P bounds")
        if start < previous - .01 or end <= start or abs(end - start - duration) > .01 or abs(part["actualDuration"] - duration) > .25:
            raise ValueError("game P is reordered, duplicated or has a wrong duration")
        previous = end
        if part.get("burnedSubtitles") is not False or not str(part.get("title") or "").strip() or len(part["title"]) > 80:
            raise ValueError("game P needs an unburned video and a valid title")
        if part.get("activityId") not in events:
            raise ValueError("game P has no source event")
        by_event.setdefault(part["activityId"], []).append(part)
        media = Path(part["mediaPath"])
        if media.stat().st_size != part["bytes"] or file_digest(media) != part["sha256"]:
            raise ValueError("game P media changed after rendering")
        if file_digest(part["srtPath"]) != part["srtSha256"]:
            raise ValueError("game P external subtitles changed")
        cues = parse_srt(part["srtPath"])
        if not cues or any(c["start"] < 0 or c["end"] <= c["start"] or c["end"] > part["actualDuration"] + .02 for c in cues):
            raise ValueError("game external subtitle timing is invalid")
        if any(a["start"] > b["start"] for a, b in zip(cues, cues[1:])):
            raise ValueError("game external subtitles are reordered")
    for event_id, event in events.items():
        check_source_window(event)
        check_frame_names(event, metadata["sourceSnapshot"])
        check_editorial_revisions(event, metadata["sourceSnapshot"])
        verification = event.get("verification") or {}
        if verification.get("decision") != "keep" or verification.get("publicCopySupported") is not True or event.get("reviewIssues"):
            raise ValueError("gameplay boundaries and chapter copy need media verification")
        if verification.get("version") in (2, 3, 4):
            frames, times = verification.get("frameObservations") or [], verification.get("frameTimes") or []
            audio = verification.get("audioObservations") or []
            if len(audio) != 2 or any(a.get("index") != i + 1 or not str(a.get("heardWords") or "").strip() for i, a in enumerate(audio)):
                raise ValueError("game original audio observations are incomplete")
            if not frames or len(frames) != len(times) or any(f.get("index") != i + 1 or f.get("activity") not in ("gameplay", "other", "watching_game", "black")
                    or not str(f.get("description") or "").strip() for i, f in enumerate(frames)):
                raise ValueError("game original frame observations are incomplete")
            if any(isinstance(t, bool) or not isinstance(t, (int, float)) or not math.isfinite(t) for t in times):
                raise ValueError("game original frame times are invalid")
            if not any(f["activity"] == "gameplay" and verification["start"] <= t < verification["end"] for f, t in zip(frames, times)):
                raise ValueError("game verification has no visible live gameplay")
            if any(f["activity"] == "gameplay" and not verification["start"] <= t < verification["end"] for f, t in zip(frames, times)):
                raise ValueError("game boundaries would omit visible live gameplay")
            if verification.get("version") in (3, 4):
                if verification["version"] == 3 and verification.get("evidenceMethod", "native_audio") != "native_audio":
                    raise ValueError("diagnostic game audio review cannot authorize publication")
                if verification["version"] == 4 and (verification.get("evidenceMethod") != "independent_local_asr" or verification.get("protocolVersion", 0) < 10):
                    raise ValueError("independent game audio review needs the original-evidence protocol")
                boundary = verification.get("boundaryReview") or {}
                if boundary.get("version") != 1 or boundary.get("decision") != "keep" or boundary.get("timeBasis") != "audio_local_seconds" or boundary.get("startObserved") is not True or boundary.get("endObserved") is not True:
                    raise ValueError("independent original game boundary review is missing")
                if boundary.get("start") != verification["start"] or boundary.get("end") != verification["end"] or boundary.get("audioObservations") != audio:
                    raise ValueError("independent game boundaries differ from the accepted session")
                if verification.get("protocolVersion", 0) >= 8:
                    check_boundary_quotes(verification, metadata["sourceSnapshot"]["srtPath"], coverage["duration"], metadata["sourceSnapshot"])
                if verification.get("protocolVersion", 0) >= 10:
                    check_original_game_frames(verification, metadata["sourceSnapshot"])
        selected = by_event.get(event_id) or []
        merged = []
        for p in selected:
            if merged and abs(merged[-1][1] - p["start"]) <= .01:
                merged[-1] = (merged[-1][0], p["end"])
            else:
                merged.append((p["start"], p["end"]))
        expected = included_ranges(event)
        if len(merged) != len(expected) or any(abs(a - c) > .01 or abs(b - d) > .01 for (a, b), (c, d) in zip(merged, expected)):
            raise ValueError("complete gameplay has a missing, overlapping or excluded interval")
    if Path(output["mediaPath"]).resolve() != Path(parts[0]["mediaPath"]).resolve():
        raise ValueError("game primary video differs from P1")
    if file_digest(output["coverPath"]) != metadata.get("coverSha256"):
        raise ValueError("game cover changed")


def validate_game_review(metadata):
    review = metadata.get("gameReview") or {}
    if metadata.get("uploadReady") is not True or review.get("version") != 1 or review.get("status") != "approved" or review.get("authority") not in ("agent", "user_authorized_automation"):
        raise ValueError("game publication review is missing")
    if not str(review.get("authorizationNote") or "").strip() or review.get("contentSha256") != content_digest(metadata):
        raise ValueError("game content or upload authorization changed after review")
    check_artifacts(metadata)
    source = metadata["sourceSnapshot"]
    stat = Path(source["mediaPath"]).stat()
    if str(stat.st_size) != source["mediaBytes"] or str(stat.st_mtime_ns) != source["mediaMtimeNs"]:
        raise ValueError("game recording changed since selection")
    for key in ("srt", "xml"):
        if source.get(key + "Path") and file_digest(source[key + "Path"]) != source[key + "Sha256"]:
            raise ValueError("game source text changed since selection")


def approve(metadata_path, authorization_note, automatic=False):
    p = Path(metadata_path)
    data = json.loads(p.read_text(encoding="utf-8-sig"))
    if not authorization_note.strip():
        raise ValueError("game upload needs explicit authorization")
    check_artifacts(data)
    data["gameReview"] = {"version": 1, "status": "approved", "authority": "user_authorized_automation" if automatic else "agent",
                          "authorizationNote": authorization_note, "contentSha256": content_digest(data)}
    data["uploadReady"] = True
    validate_game_review(data)
    tmp = p.with_suffix(".review.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(p)
    return str(p)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--metadata", required=True)
    parser.add_argument("--authorization-note", required=True)
    parser.add_argument("--automatic", action="store_true")
    args = parser.parse_args()
    print(approve(args.metadata, args.authorization_note, args.automatic))
