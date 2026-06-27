# Local one-off scripts

This directory is for local, ad-hoc scripts that are tied to specific files,
dates, upload batches, or machine paths.

Keep reusable project scripts in `src/scripts`. Files placed under this
directory are ignored by Git by default.

For upload recovery or one-time Bilibili checks, prefer:

```text
local-scripts/one-off-scripts/<date-or-task>/
```

If a script becomes useful across streams, move it out of this directory,
parameterize the paths/BV ids, and document it before committing.
