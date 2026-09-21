# Experience and generation contract

21 September approved baseline: [Kely product contract](product-contract-2026-09-21.md) supersedes the earlier direct-finished-post journey below. Discussion now produces an exact approvable plan before any artwork generation.

13 September update: [Approved redesign](redesign-2026-09-13.md) replaces the editorial visual direction and mandatory copy/cover approval sequence below. Use the new rounded, outlined, colorful minimal brief and direct finished-post journey. Historical implementation is not evidence of the new flow.

Status: product baseline. Detailed implementation design belongs to the architect's design assignment.

## Interface direction

Calm editorial workspace: warm nearly-white background, dark readable text, indigo action accent, generous spacing and neutral surroundings for each client's visuals. The product should feel like a useful creative collaborator, not a settings dashboard or an internal agent console.

Desktop: navigation for creating posts, history, business profile and billing; preparation conversation alongside the current content/visual preview. Mobile: sequential views or accessible tabs rather than a compressed two-column layout. Keep the composer and next primary action reachable with the on-screen keyboard.

Landing copy starts with the visitor's intent, for example "Tell me your post idea. We'll shape it together." Offer "Help me find an idea" without making business-description forms mandatory. Explain subscription gating honestly. Showcase examples as Kely examples, not fabricated customers, testimonials, usage counts or conversion results.

Before payment, retain typed idea and selected platform in the browser; optional URLs may be stored as text but are not fetched. After payment, resume the same intent. Uploads are an authenticated paid-flow capability, not a public upload endpoint.

## Conversation and approval

- Ask one compact batch of necessary questions at a time. Prefer an informed suggestion when its uncertainty is harmless and clearly labeled.
- Research first. Audience, CTA, mood, palette, typography category, layout and visual metaphor are Kely proposals unless the owner has constrained them. Do not turn a conventional client brief into mandatory onboarding.
- Before the plan, show what was verified, what the owner supplied, what Kely inferred and what could not be accessed. A page or social preview is never represented as a complete brand reading.
- Ask factual clarification rather than inventing prices, product features, availability, reviews, customer outcomes, medical claims or founder experiences.
- Store business facts with provenance: founder/user statement, website source with fetch time, or unverified suggestion. User corrections supersede earlier stored facts with history retained.
- Show a readable content outline and caption before visuals; approving it also confirms the factual claims displayed.
- Generate the first cover to establish style. Keep typography, palette, spacing and visual language consistent throughout a carousel while allowing meaningful composition variation.
- Text, logos and real source material must remain reliable. Use deterministic layout/composition for legible text and controlled brand assets; AI-generated artwork is an optional component, not a flattened substitute for all content.
- Constrain model output to data contracts. Do not execute model-authored HTML, JavaScript, shell commands or remote resource instructions.
- Chat revision identifies affected slides/version and expected action price before confirmation. A request for one slide must not regenerate the entire carousel by default.

## Visible states

Not started; collecting context; content awaiting approval; cover awaiting approval; visuals running; ready; revision awaiting confirmation; insufficient credits; failed with preserved draft; outcome uncertain and awaiting reconciliation. Loading messages explain the real stage without inventing progress percentages.

Explain the weekly allowance separately from subscription renewal. Show balance, reserved amount when relevant, next reset, one-off pack balance and an understandable action quote. Unused weekly credits do not roll over; purchased packs do not disappear at the weekly reset.

## Accessibility and assets

Semantic controls, visible focus, meaningful labels, keyboard traversal, readable contrast, reduced-motion support and accessible live status. Respect Unicode, Cyrillic, German diacritics, line wrapping, safe text areas and image aspect ratios. The app must not rely on color alone for approvals or failure.

Private uploads require validated file signatures, bounded byte/pixel sizes and ownership. Server-rendered exports use only approved local assets and safe layout schemas, not network access to arbitrary model-provided URLs. Maintain visual provenance and indicate where user input is still needed.

## Quality evidence

Priority update, 11 September: execute the Girex brand-source and repeat-preference scenarios in [Brand-first AI designer](brand-designer.md) before expanding language coverage. The cases below remain later regressions, not proof of the core brand-quality promise.

Use these founder-provided projects internally, with facts verified from current source material before generation:

1. Girex: English LinkedIn carousel, then a single-slide revision.
2. House of Smile: German Instagram post through the no-idea entry. Do not invent treatment outcomes or medical promises.
3. Chocolatin Labs: Russian user request with an English website; output remains Russian. Do not invent animal health certifications, availability or guarantees.
4. A second post for one saved business, demonstrating useful context/style reuse without repeating the previous post.

For each sample record factual correctness, usefulness, writing quality, typography, clipping, visual coherence, revision accuracy, final export integrity and actual cost. Founder visual acceptance is a distinct gate; developer tests cannot substitute for it.
