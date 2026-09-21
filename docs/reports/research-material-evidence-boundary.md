# Research material evidence boundary

## Incident

The first post-worker-memory live Girex run completed its paid material analysis, then failed before entity search. The returned visual observations were valid analysis output, but two excerpts were 512 and 514 characters while `brand_research_source.excerpt` accepts at most 500.

## Change

- Material observations are split into lossless, Unicode-safe 500-character evidence spans before persistence.
- Evidence IDs are deterministic RFC 4122 variant UUIDv5 values for a run, material and span index.
- Reusing the same material in another research run produces different IDs, avoiding the globally unique source-ID collision.
- Extraction receives the exact evidence IDs for every material observation instead of being invited to cite the file ID.
- The stored material analysis remains unchanged; only its evidence projection is chunked.

## Verification

- Focused orchestration tests cover an emoji on the 500-character boundary, exact reconstruction and spans, UUID validity, extraction attribution, stable replay IDs and distinct IDs across runs.
- Full unit suite, typecheck and production build are required before deployment.
- No provider call was made to diagnose or verify this change.

## Limitation

The failed live run is immutable and remains failed. A new user-requested run is required after deployment; it must pass the normal shared-budget reservation gate.

## Follow-up extraction boundary

The next live run passed material and source persistence, then returned two creative `proposed` claims with reference IDs. Proposed creative direction is not evidence-backed by definition. The parser now deterministically removes evidence IDs only from creative proposals before attribution validation. Factual, offer, price and regulated claims keep the strict original validation and cannot be normalized this way.
