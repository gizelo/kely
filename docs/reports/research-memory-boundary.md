# Brand research memory boundary

Outcome: accepted for deployment as the smallest recovery-oriented mitigation for the Render 512 MB OOM. New research-only vision derivatives are capped at a 1024 px edge and 512 KiB each, with a 1536 KiB aggregate cap. Original uploads and render/export inputs are unchanged. The provider gateway no longer makes a redundant full clone after the budget store has already canonicalized and detached the request.

Changed paths: `src/server/research-materials.ts`, `src/server/providers/gateway.ts`, `tests/research-materials.test.ts`.

Checks: 154 unit tests passed before the aggregate-byte correction; the focused derivative tests and typecheck passed after it. The production build passed with webpack; the default Turbopack build could not bind its local helper port in the execution sandbox. Existing 1536 px vision contracts remain unchanged so historical immutable budget events still replay.

Limitations: the cloud budget store still replays the complete immutable event history for each operation. This is a long-term memory amplifier and needs a separately versioned snapshot/compaction design; it is not mixed into this recovery patch. API spend: USD 0.
