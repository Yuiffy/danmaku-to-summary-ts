"""Argument declarations for the clip registry; no queue or process side effects."""

import argparse


def build_parser(api) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Manage short-id reviewed clip uploads")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("import-review", help="Import a REVIEW.md into the short-id registry")
    p.add_argument("--review", required=True)
    p.add_argument("--source", required=True)
    p.add_argument("--tags", default="小岁,虚拟主播,直播切片,岁AI切片")
    p.add_argument("--prefix", default="【小岁】")
    p.add_argument("--tid", type=int, default=21)
    p.add_argument("--state", default=None)
    p.add_argument("--label", default="")
    p.add_argument("--batch-id", default="")
    p.set_defaults(func=api.import_review)

    p = sub.add_parser("import-json", help="Import a generated clip JSON manifest into the short-id registry")
    p.add_argument("--manifest", required=True, help="批次 manifest 或单个切片 metadata JSON")
    p.add_argument("--review", default=None, help="仅作为人工审核链接保存，不参与机器解析")
    p.add_argument("--source", default="")
    p.add_argument("--tags", default="")
    p.add_argument("--prefix", default="")
    p.add_argument("--tid", type=int, default=None)
    p.add_argument("--state", default=None)
    p.add_argument("--label", default="")
    p.add_argument("--batch-id", default="")
    p.add_argument("--include-pending", action="store_true", help="Reserve IDs for persisted, unapproved metadata; never authorizes upload")
    p.set_defaults(func=api.import_json)

    p = sub.add_parser("list", help="List registered clips")
    p.add_argument("--status", default="")
    p.add_argument("--paths", action="store_true")
    p.set_defaults(func=api.list_clips)

    p = sub.add_parser("show", help="Show clip records as JSON")
    p.add_argument("ids")
    p.set_defaults(func=api.show_clips)

    p = sub.add_parser("subtitles", help="Show or prepare the editable candidate SRT by numeric ID")
    p.add_argument("--id", required=True, type=int)
    p.set_defaults(func=api.edit_candidate)

    p = sub.add_parser("correct", help="Revise candidate or own-stream subtitles; optionally queue rendering and upload")
    p.add_argument("--id", required=True, type=int)
    p.add_argument("--from", dest="from_text", required=True)
    p.add_argument("--to", dest="to_text", required=True)
    p.add_argument("--cue", type=int, default=None)
    p.add_argument("--note", default="")
    p.add_argument("--enqueue", action="store_true")
    p.set_defaults(func=api.edit_candidate)

    p = sub.add_parser("rebuild", help="Prepare a rendered own-stream/topic revision or recover an overlong candidate; never renders immediately")
    p.add_argument("--id", required=True, type=int)
    p.add_argument("--review-note", required=True)
    p.add_argument("--title", default=None)
    p.add_argument("--description", default=None)
    p.add_argument("--cover-text", default=None)
    p.add_argument("--source-kind", choices=("live_speech", "recount", "playback", "audience"), default=None)
    p.add_argument("--start", type=float, default=None)
    p.add_argument("--end", type=float, default=None)
    p.add_argument("--allow-long", action="store_true")
    p.add_argument("--duration-note", default=None)
    p.add_argument("--xml", default=None, help="Explicit original danmaku XML to bind when legacy topic metadata omitted it")
    p.add_argument("--enqueue", action="store_true")
    p.set_defaults(func=lambda args: api.clip_candidate_queue.prepare_rebuild(args, api))

    p = sub.add_parser("preview", help="Prepare reusable unburned rough video and matching SRT for held candidates; never approve or upload")
    p.add_argument("--ids", required=True)
    p.add_argument("--timeout-seconds", type=int, default=1800)
    p.set_defaults(func=lambda args: api.clip_candidate_queue.preview_candidates(args, api))

    p = sub.add_parser("cut", help="Render held topic candidates by their reserved short IDs; never auto-upload")
    p.add_argument("--ids", required=True)
    p.add_argument("--review-note", required=True)
    p.add_argument("--title", default=None)
    p.add_argument("--description", default=None)
    p.add_argument("--cover-text", default=None)
    p.set_defaults(func=api.cut_candidates)

    p = sub.add_parser("approve-review", help="Save explicit human review for a rendered own-stream clip; never uploads")
    p.add_argument("--id", required=True, type=int)
    p.add_argument("--review-note", required=True)
    p.add_argument("--title", default=None)
    p.add_argument("--description", default=None)
    p.add_argument("--cover-text", default=None)
    p.add_argument("--source-kind", choices=("live_speech", "recount", "playback", "audience"), default=None)
    p.set_defaults(func=api.approve_rendered_review)

    p = sub.add_parser("enqueue", help="Queue upload by ID; the background worker renders approved candidates first")
    p.add_argument("--ids", required=True)
    p.add_argument("--delay", type=int, default=api.DEFAULT_DELAY)
    p.add_argument("--rate-limit-wait", type=int, default=api.DEFAULT_RATE_LIMIT_WAIT)
    p.add_argument("--rate-limit-retries", type=int, default=api.DEFAULT_RATE_LIMIT_RETRIES)
    p.add_argument("--batch-size", type=int, default=api.DEFAULT_BATCH_SIZE)
    p.add_argument(
        "--timeout-seconds",
        type=int,
        default=api.DEFAULT_BATCH_TIMEOUT_SECONDS,
        help="每个小批次的子进程超时秒数",
    )
    p.add_argument("--note", default="")
    p.add_argument("--force", action="store_true")
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(func=api.enqueue)

    p = sub.add_parser("cancel", help="Cancel a pending upload job")
    p.add_argument("--job", required=True)
    p.add_argument("--note", default="")
    p.set_defaults(func=api.cancel_job)

    p = sub.add_parser(
        "resume",
        help="Clear a manually confirmed-stale Bilibili submission cooldown",
    )
    p.add_argument("--note", default="")
    p.set_defaults(func=api.resume_uploads)

    p = sub.add_parser("queue", help="Show upload queue")
    p.add_argument("--verbose", action="store_true")
    p.set_defaults(func=api.queue_status)

    p = sub.add_parser("worker", help="Run one queued upload job or loop forever")
    p.add_argument("--loop", action="store_true")
    p.add_argument("--interval", type=int, default=30)
    p.add_argument("--idle-interval", type=int, default=30)
    p.set_defaults(func=api.worker)
    return parser
