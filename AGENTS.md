## Windows shell

- Use the shell already provided by the Codex runtime.
- Do not launch a new `pwsh.exe` or `powershell.exe` process for every command.
- Prefer commands compatible with the current Windows shell.
- Treat text files as UTF-8.

## File placement and Git hygiene

- Decide whether a new file is reusable project material before creating it.
  Tracked directories are for files intended to be maintained and shared through Git.
- Put task-specific plans, research notes, experiment/benchmark results, rollout
  reports, handover notes, downloaded pages, screenshots, API responses, and scratch
  data in the ignored `temp/<date>-<task>/` directory. Existing `tmp/<task>/` areas
  are also local-only. This applies to Markdown and JSON, not just scripts or media.
- Put one-off scripts tied to fixed recordings, dates, BV IDs, batches, or machine
  paths in `local-scripts/one-off-scripts/<date-or-task>/` or the task's `temp/`
  directory. Do not create them at repository root or in `src/`, `scripts/`, or `tools/`.
- Keep `docs/` and `plans/` for maintained guides, contracts, architecture decisions,
  and reusable project roadmaps. Extract durable rules into an existing guide;
  keep the individual task's evidence and execution diary in its ignored directory.
- Keep reusable code, automated regression tests, minimal intentional fixtures,
  configuration examples, and required runtime/reference assets in their existing
  tracked directories. A date in a filename alone does not make an asset disposable.
  Check callers, documentation links, and asset provenance before moving it.
- Do not make tracked code/tests depend on ignored task files. Parameterize and
  document a local helper, with appropriate tests, before promoting it to shared code.
- Before staging, inspect `git status --short`, `git diff --cached --name-status`,
  and `git ls-files -ci --exclude-standard`. Check local destinations with
  `git check-ignore -v -- <path>`. Ignore rules do not untrack existing files;
  preserve the local copy before `git rm --cached -- <path>`. Never force-add
  temporary files or rewrite history as part of routine cleanup.

## Project skills

- Reusable agent workflows live under `.agents/skills/`.
- For Sui livestream topic search, queued clipping, subtitle burning, old-recording clips, or post-stream automatic selection, read `.agents/skills/sui-clip-queue/SKILL.md` first.
- For numeric candidate IDs, user-confirmed subtitle replacements, or "correct, burn and upload" requests, read the candidate command recipe in `docs/topic-event-editorial.md`. Use `clip_upload_registry.py correct --id ... --from ... --to ... --enqueue`; do not hand-edit queue JSON or run FFmpeg/ASR/upload scripts for that workflow.
