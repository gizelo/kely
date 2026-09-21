# Brand Intelligence before planning

Status: accepted product and architecture direction; implementation staged. This extends, but does not replace, the existing public-reference importer.

## Product promise

Kely behaves like a prepared designer and social-content specialist. The owner supplies the smallest reliable identity input: a business or product name plus location/category when needed. An official URL and files are optional accelerators, not questionnaire prerequisites. Before asking for ordinary creative choices, Kely researches what can be established from public sources and saved materials.

The pre-plan journey is:

`idea → resolve the business → research official sources → review evidence → ask only blockers → propose an exact plan → approval → generation`

Research is part of the accepted creation package. It is not a separately sold action and it is not unbounded background monitoring. A completed snapshot is reusable until its sources or confirmed owner corrections change.

## Professional autonomy rule

Kely decides or proposes audience, CTA, mood, palette, typography category, layout, visual metaphor and slide structure when the owner has not expressed a preference. These are never blockers by themselves.

Kely asks only when:

- the post depends on a price, date, result, offer term or product claim that is unsupported;
- an exact logo, interface, product image or other required original is unavailable;
- regulated, medical, financial, legal or customer-result language is ambiguous;
- sources conflict materially;
- more than one plausible business entity remains after deterministic matching.

Questions are one compact batch of at most three. Every factual blocker offers a safe fallback such as omitting the claim. Harmless creative uncertainty is resolved by Kely and remains editable in the plan.

## Research stages

### 1. Identity resolution

User-supplied official origins have priority. Name-only discovery creates separate entity candidates and never merges them. Automatic selection requires a high-confidence match based on deterministic signals such as exact domain, reciprocal official links, name, location and product/category agreement. Ambiguity pauses before content is combined.

### 2. Bounded acquisition

The first implementation uses an official URL, the saved business website and explicitly supplied social/post links. From an accepted official page it may discover only bounded same-origin pages, canonical metadata and public Instagram/LinkedIn links. Broad search is a later capability behind the same contract.

Network access reuses the pinned public-address boundary. It does not follow model-authored URLs, authenticate, bypass a login or anti-bot wall, or treat a social preview as a complete profile reading. Per run, page, origin, byte and wall-clock limits are mandatory. Robots policy is checked before any multi-page crawl.

### 3. Evidence extraction

Fetched content is untrusted data. A research model has no tools and cannot select another URL. It may only return a strict evidence proposal. The server validates every observed fact against a bounded exact excerpt from a fetched document.

Each atomic finding contains:

- type: business fact, voice signal, visual signal, material or constraint;
- value and status: `observed`, `proposed`, `confirmed` or `contradicted`;
- confidence: `low`, `medium` or `high`;
- source URL, fetch time, content hash and exact evidence excerpt;
- entity identifier and extractor version.

Public media remains a reference. Public availability is not proof of ownership or a reusable original. Store only bounded excerpts and normalized previews required for evidence.

### 4. Readiness and questions

A deterministic classifier, not the model, converts findings into blockers and recommendations. Unsupported factual copy is rejected even if it appears in model output. Owner corrections create superseding evidence and preserve history.

### 5. Frozen plan input

The creation operation freezes the research ID, snapshot hash, entity ID and source hashes. A later refresh cannot alter an approved plan or result. Plan items distinguish `Verified from source`, `Told by you`, `Kely proposes` and `Needs confirmation`.

## Durable operation contract

Research has one idempotency key and immutable input hash. Repeating the same input returns the saved run; different input conflicts. Partial source outcomes remain durable. An unknown provider outcome retains its exposure and is never retried automatically.

The state machine is:

`queued → resolving → fetching → extracting → review_ready | needs_input | partial | failed | uncertain`

The complete creation budget reserves its worst-case accepted research, planning and artwork envelope before the first provider dispatch.

## UX contract

New-post intake keeps one primary idea field, platform and a compact source area. It does not force a choice between materials, link and Kely deciding; inputs may be combined. Audience, desired action, palette, font and mood are not form requirements. Only one optional `must use or avoid` field remains visible before research.

Research progress uses named durable stages, never fake percentages. Review shows inspected domains/files, confirmed findings, inferred style, inaccessible sources and blockers. The owner may remove or correct a finding before proceeding.

## Phased delivery

1. Pure versioned Brand Intelligence contract, entity resolution and deterministic readiness classifier.
2. Official-URL research with bounded page discovery, evidence storage and research-review UI.
3. Freeze accepted research into plan-first creation and validate every factual claim.
4. Add broad public search only after its provider, official-identity rules and budget envelope are accepted.
5. Evaluate URL-rich, name-only ambiguous, website-only, files-only and no-material cases before enabling real calls by default.

## Acceptance gates

- Sufficient evidence reaches a plan without a questionnaire.
- Ambiguous same-name companies never have sources merged.
- A hostile page instruction remains quoted evidence and cannot cause a tool call, URL fetch or saved preference.
- Missing offer terms or required originals produce one bounded question batch; optional creative preferences do not.
- Every factual claim resolves to frozen evidence or an exact owner statement.
- Refresh, duplicate submission and restart do not repeat fetches or provider charges.
- Login-walled social sources are described as unavailable; uploaded screenshots remain references.
- No real research or generation exceeds the shared development budget authority.
