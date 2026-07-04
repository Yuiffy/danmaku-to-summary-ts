# Local one-off scripts

This directory is for local, ad-hoc scripts that are tied to specific files,
dates, upload batches, or machine paths.

Keep reusable project scripts in `src/scripts`. Files placed under this
directory are ignored by Git by default.

Temporary or one-off files should not be added to Git. Use these locations:

- `local-scripts/one-off-scripts/<date-or-task>/` for disposable scripts used to
  inspect APIs, retry uploads, fix a specific batch, or operate on fixed BV ids.
- `tmp/` for scratch data, exported responses, logs, and other temporary output.

Only move scripts back into `src/scripts` when they are reusable, parameterized,
and documented for future runs.

For upload recovery or one-time Bilibili checks, prefer:

```text
local-scripts/one-off-scripts/<date-or-task>/
```

If a script becomes useful across streams, move it out of this directory,
parameterize the paths/BV ids, and document it before committing.
