# Historical migration guide

The transition from the old webhook scripts to the TypeScript service is complete.
The one-time migration generator was removed in September 2026 because rerunning
it overwrote current configuration and startup scripts with obsolete defaults.

Use the maintained documentation:

- [Architecture and language policy](../../docs/architecture.md)
- [Runtime commands and endpoints](../../docs/runtime-notes.md)
- [Project commands and setup](../../README.md)

For development, run `npm run verify:all`. Its compiled workflow tests emit to
`build/service`; they do not clean or replace the running `dist`.
