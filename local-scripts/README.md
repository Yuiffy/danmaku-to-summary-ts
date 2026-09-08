# Local one-off scripts

This directory is for local, ad-hoc scripts that are tied to specific files,
dates, upload batches, or machine paths.

Keep reusable project scripts in `src/scripts`. Files placed under this
directory are ignored by Git by default.

Temporary or one-off files should not be added to Git. Use these locations:

- `local-scripts/one-off-scripts/<date-or-task>/` for disposable scripts used to
  inspect APIs, retry uploads, fix a specific batch, or operate on fixed BV ids.
- `local-scripts/legacy-tests/` for old manual probes that are not part of the
  automated Jest or Python test suites.
- `local-scripts/artifacts/` for local binary probes and diagnostic captures
  that should not live at repository root.
- `tmp/` for scratch data, exported responses, logs, and other temporary output.
- `temp/<date>-<task>/` for all files belonging to one task, including Markdown
  plans, experiment results, deployment/verification reports, handover notes,
  screenshots, downloaded pages, and API response dumps.

`AGENTS.md` defines the repository-wide placement rules. `docs/` and `plans/`
are not task diaries: keep maintained guides, contracts, architecture decisions,
and reusable roadmaps there. Summarize durable findings in an existing guide
without making it depend on a local report. Only this README is tracked under
`local-scripts/`; do not force-add the ignored contents.

When cleaning up previously tracked task files, preserve their relative paths
under `temp/<cleanup-task>/files/` and keep a local manifest of original paths,
destinations, and hashes. Verify the copies and ignore rules before removing the
originals from the Git index. Mutable runtime files already in ignored locations
such as `logs/` should stay at their runtime paths and only be untracked.

Only move scripts back into `src/scripts` when they are reusable, parameterized,
and documented for future runs.

For upload recovery or one-time Bilibili checks, prefer:

```text
local-scripts/one-off-scripts/<date-or-task>/
```

If a script becomes useful across streams, move it out of this directory,
parameterize the paths/BV ids, and document it before committing.
