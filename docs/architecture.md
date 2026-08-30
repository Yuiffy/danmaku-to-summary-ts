# Architecture and language policy

This document is the starting point for changes to the production pipeline. It
describes the current boundaries, not an aspirational directory tree.

## Runtime map

```text
Mikufans / DDTV HTTP events
  -> src/app/main.ts
  -> src/services/webhook
     -> MikufansWebhookHandler (event ordering and segment lifecycle)
     -> MikufansSummaryQueueWorker (central summary queue and process boundary)
     -> delayed-reply trigger callback
  -> src/scripts/enhanced_auto_summary.js
     -> media preparation and workflow orchestration
     -> src/scripts/asr/*.js
        -> src/scripts/python/*.py
  -> generated JSON/Markdown/image sidecars
  -> src/services/bilibili/DelayedReplyService.ts
  -> Bilibili API and WeChat Work notifications
```

PM2 runs `dist/app/main.js`, while the media pipeline intentionally continues
to execute selected source scripts. A build therefore does not deploy itself;
production changes require an explicit, separately reviewed PM2 reload.

## Ownership boundaries

| Area | Owns | Must not own |
| --- | --- | --- |
| `src/app` | process startup, CLI, HTTP composition | media algorithms or room policy |
| `src/core` | configuration, logging, errors, shared infrastructure | streamer-specific behavior |
| `src/services` | long-running state, external adapters, business workflows | one-off batch operations |
| `src/services/ai/goodnight` | room naming policy, reply prompts, generated-text validation | provider HTTP calls or file persistence |
| `src/services/webhook/handlers/mikufans` | ASR resource admission, summary queue execution, and delayed-reply coordination callbacks | recording lifecycle state or Bilibili publishing policy |
| `src/services/bilibili/delayed-reply` | artifact resolution, summary composition, diagnostics, timer lifecycle | HTTP routing, recording lifecycle |
| `src/scripts` | compatible CLIs and the legacy media workflow | new long-running services |
| `src/scripts/python` | Python ML/ASR implementations | Node process orchestration |
| `local-scripts` | machine-, date-, or batch-specific work | reusable project behavior |
| `data/runtime`, `logs`, `tmp`, `output` | local mutable state and generated artifacts | source code |

Dependencies should point inward: entrypoints compose services; services may
use core utilities; focused components must not import their parent handler or
service. Cross-language calls are process boundaries, not source imports.

## Language decision

The project should not be converted to one language wholesale.

- TypeScript is the default for every new Node module, shared rule, HTTP
  handler, queue, scheduler, and long-running service. `src/app`, `src/core`,
  `src/services`, `src/utils`, and `src/tools` are TypeScript-only.
- JavaScript is a compatibility layer for the existing media workflow. Migrate
  it incrementally when a script is touched: extract a tested TypeScript module
  first, then leave the old `.js` path as a thin CLI wrapper until PM2, docs,
  and local automation have moved.
- Python remains the implementation language for ASR, speaker processing,
  model runtimes, and Python-native Bilibili/media tooling. Rewriting those in
  TypeScript would remove ecosystem support without reducing operational
  complexity.
- Node/Python communication must use explicit arguments, environment fields,
  JSON sidecars, or documented sentinel lines. Do not parse incidental log text
  as an API and do not duplicate configuration defaults on both sides.

`tsconfig.build.json` rejects JavaScript so the production control plane cannot
silently gain new JS and refuses to emit a partial `dist` when type errors are
present. The root `tsconfig.json` still has `allowJs` during the legacy migration
because TypeScript tests import existing workflow scripts.

## Current ratchets

`npm run architecture:check` enforces these constraints:

- production TypeScript files default to at most 1,200 physical lines;
- the two remaining large stateful services have explicit budgets of 2,850 and
  1,800 lines, which may only move downward;
- JavaScript and Python cannot enter the production TypeScript directories;
- `MikufansWebhookHandler` cannot import the legacy queue/workflow modules;
- delayed-reply timers must stay in `DelayedReplyScheduler`;
- source-like files cannot be added at repository root;
- the service build must keep `allowJs: false`.

The 2026-08-27 split moved artifact lookup, generation diagnostics, live-content
composition, ASR resource ownership, and delayed-reply triggering out of the two
largest services. The follow-up extraction moved timer ownership and the summary
queue's durable enqueue/process boundary as well, leaving the webhook handler
focused on event ordering, reconnect handling, and session finalization:

1. Keep delayed-reply timers in `DelayedReplyScheduler`; do not add timer
   handles back to `DelayedReplyService`.
2. Keep the summary queue and durable enqueue boundary in
   `MikufansSummaryQueueWorker`; do not add queue or
   child-process orchestration back to `MikufansWebhookHandler`.
3. Migrate `enhanced_auto_summary.js` one stage at a time behind its existing
   CLI contract.
4. Ratchet the two exception budgets after each extraction; do not create more
   exceptions.

## Change guide

- Recording event ordering, reconnects, or segment finalization:
  `MikufansWebhookHandler` and `LiveSessionManager`.
- Queue recovery, GPU/game admission, the persistent Python worker, or the
  `enhanced_auto_summary.js` child process:
  `MikufansSummaryQueueWorker` and `MikufansAsrResourceController`.
- Room naming, goodnight prompt wording, or generated-reply validation:
  `GoodnightReplyPolicy`.
- Finding generated goodnight files and registering delayed tasks:
  `MikufansDelayedReplyCoordinator` and `DelayedReplyArtifactResolver`.
- Bilibili timing, retries, and idempotency: `DelayedReplyService`.
- Live-content JSON parsing and comment length policy:
  `LiveContentSummaryComposer`.
- Operator notification details from ASR/image metadata:
  `DelayedReplyDiagnostics`.

Before changing a production path, add a focused unit test at the owning module.
Run `npm run verify:core` (it includes `build:check`) without touching `dist`. For a deploy candidate, build
to an isolated output directory and smoke-test on a non-production port before
an explicitly approved PM2 reload.
