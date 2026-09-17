# Kely cloud beta

Status: open-registration transition approved 17 September 2026; generation remains allowance-gated and payments remain disabled.

The founder-approved 17 September transition supersedes the invite-only access rule below: public account creation is permitted, new accounts start with zero credits, and founder/test access remains separately granted. It does not authorize sales, automatic top-ups, domain purchases or a larger API budget.

## Product

Idea → bounded discussion → saved plan → explicit Generate → complete publication → scoped revision. The plan includes format, 1–6 slides and their copy, caption and visual direction. No artwork before exact plan approval. Changing the plan invalidates approval. Standing confirmed preferences outrank inferred references; current-post overrides do not silently become standing preferences.

The UI hides per-action prices and payment dialogs. Usage belongs in Account; low/insufficient allowance is disclosed before dispatch. Internal reservations and actual provider accounting remain mandatory. Technical defects do not consume the customer allowance; corrections are bounded, never unlimited automatic retries. Old publication versions and request envelopes retain their original semantics.

## Hosting and access

Render Free + Neon Free, preferably EU regions. One web service runs web and worker processes; persisted operations survive idle/restart. No artificial keepalive. PostgreSQL holds private files and provider evidence under a combined 200 MB cap. Cloud starts with clean user data; local data remains untouched. Public signup grants no allowance and live billing stays disabled. Up to three separately invited test accounts may receive the test allowance. Single-use expiring invitations, founder-issued recovery links, secure cookies, exact origin checks, rate limits and private owner-scoped downloads remain release gates.

The existing development authority has a USD 10 lifetime ceiling. Cloud transfer must preserve immutable history, retained liabilities and remaining allowance, fence local dispatch and verify the imported state before enabling cloud dispatch. No second allowance, ledger reset or uncertain paid retry. Only root may apply the actual transfer.

Before tester invitations: founder accepts output, privacy/contact text, tested backup restoration, cloud restart/download behavior and independent security review. A target date does not waive gates. No commercial uptime claim on a free sleeping host.

## Ownership

- Root: coordination, auth/invites/recovery, origin/config, hosting launcher, deployment, actual budget transfer, acceptance and Notion.
- beta_cloud_budget: PostgreSQL accounting/transfer, private binary storage and quota, migration 011, focused tests.
- beta_plan_engine: creation contracts/runner/API and versioned composition, migration 012 if required, focused tests.
- beta_plan_ui: components/CSS, plan-first interaction, usage-only beta surfaces and visual review.
- Independent security/design reviewers: after implementation handoff; no acceptance based solely on code tests.

All agents use fixtures until coordinator clearance. No agent edits shared AGENTS.md. Completion reports belong in docs/reports.
