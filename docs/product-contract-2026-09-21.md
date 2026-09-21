# Kely product contract — 21 September 2026

Status: approved implementation baseline. This contract supersedes conflicting journey, public-access and allowance presentation decisions in earlier product addenda. Historical reports remain evidence only for the version they tested.

## Product outcome

Kely is a warm, gender-neutral AI designer for owner-led small businesses. The supported journey is:

**idea → bounded discussion → exact post plan → explicit approval → Generate → saved publication → scoped revision → selective preference memory**

One publication is one Instagram or LinkedIn static image or a carousel of at most six slides. Artwork is never generated before the current plan is approved. Changing copy, slide count, caption or visual direction invalidates that approval.

The visible allowance is expressed as weekly post slots. One slot reserves one complete creation package: bounded discussion, plan, finished publication and one scoped user revision. A verified technical defect does not consume another slot. A materially new concept requires confirmation that another slot will be used. Exact customer credits and provider cost remain internal ledgers.

## Public access

`/` is a pre-launch marketing page with a real waitlist form. It contains no login link, signup, checkout or apparently live pricing. Examples are accepted Kely outputs or are explicitly labeled concepts.

`/login` is available only by direct URL and supports sign-in only. Public signup is rejected by the server regardless of client behavior or environment configuration. Test accounts and allowances are created through a controlled operator command. Email delivery and self-service recovery are out of scope for this test stage.

The waitlist stores a normalized email, consent, source and creation time with idempotent duplicate handling and persistent rate limiting. It sends no email. Public copy must not imply that joining grants access.

## Brand context and memory

Kely accepts PNG/JPEG originals and references, an optional public website or social-post URL, free-text preferences, or delegated creative choice. Website and social acquisition are best-effort references. If the source is inaccessible or incomplete, Kely asks for saved originals or screenshots rather than claiming full analysis.

Brand facts and preferences are versioned structured data with provenance and confidence. Current-post instructions override standing preferences for that publication. Revision evidence may be classified as local or durable. A durable preference is saved automatically, acknowledged with “I’ll remember this for future posts”, and can be undone. Model output never rewrites system instructions or directly selects tools.

## Result and acceptance

The result prioritizes the artwork, with caption, provenance and version history progressively disclosed. Deterministic composition owns approved text, logos and exact source assets; generated artwork is an optional visual layer. Previous successful versions remain exportable. PNG, ZIP, caption and applicable PDF downloads never start provider work.

Acceptance requires browser evidence for landing/waitlist, direct login, two-owner isolation, plan approval, duplicate/reload safety, real generation, scoped revision, memory reuse, exports, mobile layout, keyboard access, Render restart and insufficient allowance. Real output quality is evaluated separately for Girex with materials, a website-only business and a no-material business. The lifetime development provider ceiling remains USD 10.

