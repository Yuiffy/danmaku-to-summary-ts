"""Compare production CAM++ row decisions with a staged reference; never promote it.

Corpus JSON: records with id/path/start_s/duration_s/split and optional expected,
source_id/identity_basis. Candidate JSON: references and source_ids. Holdouts must
have independent, source-checked identities. All paths use --project-root.
"""
import argparse
import hashlib
import json
import math
import subprocess
from datetime import datetime, timezone
from pathlib import Path


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def resolve_path(value, root):
    path = Path(value)
    return path.resolve() if path.is_absolute() else (root / path).resolve()


def validate_corpus(records, candidate_source_ids=()):
    if not isinstance(records, list) or not records:
        raise ValueError("corpus.records must be a nonempty list")
    if not isinstance(candidate_source_ids, (list, tuple)) or any(
            not isinstance(item, str) or not item.strip() for item in candidate_source_ids):
        raise ValueError("candidate source_ids must be a list of nonempty source identifiers")
    ids = set()
    for row in records:
        identifier = str(row.get("id", "")).strip()
        if not identifier or identifier in ids:
            raise ValueError("corpus record IDs must be present and unique")
        ids.add(identifier)
        start, duration = float(row.get("start_s", 0)), float(row["duration_s"])
        if not math.isfinite(start) or not math.isfinite(duration) or start < 0 or duration < 1:
            raise ValueError(f"invalid interval: {identifier}")
        if not row.get("path"):
            raise ValueError(f"missing audio path: {identifier}")
        if row.get("split", "probe") not in {"holdout", "control", "probe"}:
            raise ValueError(f"invalid corpus split: {identifier}")
        if row.get("split") == "holdout":
            if not all(row.get(k) for k in ("source_id", "identity_basis", "expected")):
                raise ValueError(f"holdout requires source_id, identity_basis and expected: {identifier}")
            if not candidate_source_ids:
                raise ValueError("holdout evaluation requires candidate source_ids")
            if row["source_id"] in candidate_source_ids:
                raise ValueError(f"holdout reuses a candidate source: {identifier}")


def summarize_rows(rows):
    summary = {}
    for row in rows:
        split = row.get("split", "probe")
        group = summary.setdefault(split, dict(count=0, changed=0, baselineUnknown=0,
            candidateUnknown=0, knownToUnknown=0, unknownToKnown=0, knownIdentityChanged=0,
            declaredExpectedCount=0, baselineExpectedMatches=0, candidateExpectedMatches=0))
        group["count"] += 1
        before, after = row["baseline"]["label"], row["candidate"]["label"]
        group["changed"] += before != after
        group["baselineUnknown"] += before == "UNKNOWN"
        group["candidateUnknown"] += after == "UNKNOWN"
        group["knownToUnknown"] += before != "UNKNOWN" and after == "UNKNOWN"
        group["unknownToKnown"] += before == "UNKNOWN" and after != "UNKNOWN"
        group["knownIdentityChanged"] += before != after and before != "UNKNOWN" and after != "UNKNOWN"
        if row.get("expected"):
            group["declaredExpectedCount"] += 1
            group["baselineExpectedMatches"] += before == row["expected"]
            group["candidateExpectedMatches"] += after == row["expected"]
    return summary


def decode_window(row, root):
    import numpy as np
    result = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-ss", str(row.get("start_s", 0)),
        "-i", str(resolve_path(row["path"], root)), "-t", str(row["duration_s"]), "-vn", "-ar", "16000", "-ac", "1",
        "-f", "f32le", "pipe:1"], capture_output=True, timeout=120, check=True)
    audio = np.frombuffer(result.stdout, dtype="<f4").copy()
    if len(audio) < float(row["duration_s"]) * 16000 * .95 or not np.isfinite(audio).all():
        raise ValueError(f"truncated or invalid audio: {row['id']}")
    return audio


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-root", type=Path, default=Path(__file__).resolve().parents[3])
    parser.add_argument("--config", default="config/production.json")
    parser.add_argument("--backend", default="paraformer")
    parser.add_argument("--corpus", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--device", default="cpu")
    args = parser.parse_args()
    root = args.project_root.resolve()
    config = read_json(resolve_path(args.config, root))["asr"][args.backend]
    candidate = read_json(resolve_path(args.candidate, root))
    records = read_json(resolve_path(args.corpus, root))["records"]
    validate_corpus(records, candidate.get("source_ids", []))
    references, additions = config.get("speaker_references", []), candidate.get("references", [])
    if not references or not additions:
        raise ValueError("baseline and candidate references must not be empty")
    evidence = []
    for ref in [*references, *additions]:
        ref["audio_path"] = str(resolve_path(ref["audio_path"], root))
        evidence.append({**ref, "sha256": sha256(ref["audio_path"])})
    candidate_hashes = {item["sha256"] for item in evidence[len(references):]}
    holdout_paths = {resolve_path(row["path"], root) for row in records if row.get("split") == "holdout"}
    source_hashes = {str(path): sha256(path) for path in sorted(holdout_paths)}
    if candidate_hashes.intersection(source_hashes.values()):
        raise ValueError("holdout audio is identical to a candidate reference")

    import torch
    from funasr import AutoModel
    from sensevoice_text import resolve_cached_model_name
    from sensevoice_speaker import _generate_speaker_embeddings, build_speaker_reference_centroids, classify_speaker_rows
    torch.set_num_threads(2)
    model = AutoModel(model=resolve_cached_model_name("cam++"), device=args.device, disable_update=True, disable_pbar=True)
    options = dict(batch_size=config.get("speaker_embedding_batch_size", 64),
        prototype_merge_threshold=config.get("speaker_reference_prototype_merge_threshold", .72),
        max_prototypes=config.get("speaker_reference_max_prototypes", 6),
        prototype_min_support_chunks=config.get("speaker_reference_prototype_min_support_chunks", 2))
    banks = {name: build_speaker_reference_centroids(model, refs, args.device, **options)
        for name, refs in (("baseline", references), ("candidate", [*references, *additions]))}
    for name, refs in (("baseline", references), ("candidate", [*references, *additions])):
        if not banks[name] or set(ref["speaker"] for ref in refs) - set(banks[name]):
            raise RuntimeError(f"reference extraction omitted speakers in {name}")
    parameters = dict(threshold=config.get("speaker_row_reference_threshold", .55),
        margin_threshold=config.get("speaker_row_reference_margin", .08), top_k=config.get("speaker_row_reference_top_k", 3))
    rows = []
    for row in records:
        with torch.inference_mode():
            embeddings = _generate_speaker_embeddings(model, [decode_window(row, root)], batch_size=1)
            if not embeddings or any(item is None or not torch.isfinite(item).all() for item in embeddings):
                raise RuntimeError(f"invalid embedding: {row['id']}")
            matrix = torch.cat(embeddings)
            decisions = {name: classify_speaker_rows(matrix, bank, **parameters)[0] for name, bank in banks.items()}
        rows.append({**row, **decisions})
    report = dict(schemaVersion=1, createdAt=datetime.now(timezone.utc).isoformat(), humanAudited=False,
        configPath=str(resolve_path(args.config, root)), backend=args.backend, model="cam++", device=args.device,
        parameters=parameters, prototypeParameters=options, references=evidence,
        candidateSourceIds=candidate.get("source_ids", []), holdoutSourceHashes=source_hashes,
        summary=summarize_rows(rows), rows=rows,
        limitations="Source claims require independent checks. Source ID/hash separation cannot detect edited copies. Control agreement is regression evidence, not independent identity truth or full-stream DER.")
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(dict(report=str(args.report), summary=report["summary"]), ensure_ascii=False))


if __name__ == "__main__":
    main()
