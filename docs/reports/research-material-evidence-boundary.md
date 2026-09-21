# Research material evidence boundary

## Incident

The first post-worker-memory live Girex run completed its paid material analysis, then failed before entity search. The returned visual observations were valid analysis output, but two excerpts were 512 and 514 characters while `brand_research_source.excerpt` accepts at most 500.

## Change

- Material observations are split into lossless 500-character evidence spans before persistence.
- Evidence IDs are deterministic for a run, material and span index.
- Reusing the same material in another research run produces different IDs, avoiding the globally unique source-ID collision.
- The stored material analysis remains unchanged; only its evidence projection is chunked.

## Verification

- Focused orchestration tests cover the exact 1,000-character boundary, stable replay IDs and distinct IDs across runs.
- Full unit suite, typecheck and production build are required before deployment.
- No provider call was made to diagnose or verify this change.

## Limitation

The failed live run is immutable and remains failed. A new user-requested run is required after deployment; it must pass the normal shared-budget reservation gate.
