# Economics and billing contract

21 September approved baseline: [Kely product contract](product-contract-2026-09-21.md) replaces visible per-action pricing for this test stage with weekly post slots. Exact credit and provider ledgers remain internal and authoritative.

13 September approved product change: [Redesign contract](redesign-2026-09-13.md) requires one accepted total creation price including necessary intake, brand analysis and completed visuals. Separate internal-stage customer quotes below describe the old implementation and must not define the new UX. Architect must specify bounded package accounting and compensation before dispatch uses that package. The lifetime USD 10 authority and existing ledger history remain unchanged; actual localhost generation will be the ordinary founder experience after verification.

Status: approved mechanics; commercial prices and quotas remain unvalidated until measured. No live billing or financial profitability claim is authorized.

## Offering

Two tiers, identical features/quality and different usage allowance. Monthly or annual upfront billing. Present annual as the best-value option only with its actual discount, total charge and renewal clearly visible. Show the monthly alternative alongside it.

Subscription credits renew every seven days from activation, without rollover. Payment cadence and allowance cadence are separate. A monthly renewal must not change the weekly anchor or grant another full allowance. Missed/unused weeks never accumulate on login.

Upgrade is the primary insufficient-balance option; a one-off credit pack is secondary. Never auto-purchase. A purchased pack is a separate balance, does not expire on weekly reset, remains usable after subscription end, and has no expiration in the local v1 policy. New packs require an active subscription. Spend expiring weekly credits before pack credits.

Cancellation stops renewal and preserves paid access through the paid period. Weekly credits cannot fund new actions after paid access ends, even if their seven-day bucket window has not ended; only purchased packs can fund new actions then. Timely confirmed renewal preserves the current weekly window and balance without another grant. Existing artifacts remain readable/downloadable afterward. Upgrade only after verified payment; grant only the time-proportional remaining weekly difference, not a duplicate whole allowance. Downgrade and cadence changes apply at the next paid renewal.

## Action pricing and ledgers

11 September ARCH-008 local approval: a scoped visual-plan revision costs3 simulated credits for one usable saved plan proposal. Before accepting it, explain that rendering the accepted plan is a separate8-credit action, so completing both stages costs11. The proposal does not change copy, caption, Brand or existing images. Require renewed content/plan approval and an explicit composition quote before rendering; a rejected proposal does not start that later stage. Preserve untouched slides and previous successful versions. These are provisional simulator action prices, not validated commercial margins. No extra unquoted classifier, analysis or model retry is included implicitly.

11 September ARCH-007 approval: implement one separately quoted brand-analysis proposal for 3 simulated credits, with one bounded Luna vision attempt, 1–3 selected normalized image derivatives, explicit high detail and 4096 output tokens. It does not consume or extend preparation replies. Capture only a usable durably saved proposal; known unusable output releases customer credits while actual provider cost remains recorded; uncertain work retains reservations and blocks replacement attempts. Confirmation is free and version checked. Full-context conservative admission is 532373 microUSD under the separately versioned policy; original text-policy replay must remain unchanged. This approves implementation/fake tests, not live dispatch or commercial profitability. Contract: `architecture-art-direction.md`.

Brand-first update, 11 September: source analysis, preference extraction and creative readiness checks are part of the costed product, not free unbounded background agents. Merely storing user-supplied materials/rules may be deterministic; any model analysis must use an accepted bounded operation and the shared provider authority. Reuse approved brand versions and materials rather than reanalyzing them per post. Existing three-reply/four-attempt package limits remain in force during fixture foundation work; a replacement intake quote/compensation policy must be accepted before additional live analysis. Never trade a budget stop for knowingly inadequate visual generation. See `brand-designer.md`.

Expose credits for understandable bounded actions: preparation dialogue, cover generation, remaining visuals, requested revision or platform adaptation. Do not bill arbitrary tokens or every internal message to the user. Quote before work; bind the quote to exact inputs, version and bounded scope. Changing the scope requires a new accepted quote.

The preparation quote includes up to three bounded assistant replies; reserve credits before the first exchange, then capture the package price when the first usable reply is durably saved and available to the user. Disclose this activation and the included reply count before acceptance. Closing the tab does not refund consumed preparation or keep its customer reservation open indefinitely. Persist the remaining included replies with the draft so they can be resumed; additional replies beyond the package require another explicit quote. Internal dollar reservations are per actual provider attempt, not hypothetical unstarted future replies. Hidden extraction, moderation/validation if used, failed attempts and service overhead must fit the package's internal cost envelope rather than be ignored. M3 may exercise a single-response fixture; the bounded real dialogue remains an M4 requirement.

The included replies cover clarification or copy refinement for the same publication before content approval. Explain that approving content completes preparation; remaining replies are not transferable to another publication or a later visual-revision stage. A reply within the active package must not be charged again as a separate revision. Later changes use a fresh scoped revision quote and invalidate affected approvals.

For local M4B, bound each preparation package to four provider attempts: up to three usable replies and one explicitly requested retry of a known failed reply. Failed replies do not consume the usable-reply allowance. Uncertain outcomes require reconciliation before any retry. Exhaustion pauses the package for coordinator review with work and unused replies preserved; it must not demand a new paid package to remedy our failure. Include this extra attempt in the internal cost envelope. Customer compensation/recovery after exhausted attempts must be finalized before commercial use; the local review state is not production support.

Maintain two independent append-only ledgers:

1. Customer credits: grants, reservations, capture, release, refunds and corrections with an idempotent reference.
2. Actual provider spend: attempts, conservative reservations, confirmed usage/rates and unresolved exposure.

Concurrent requests cannot overspend either balance. A reservation made before a weekly reset stays attached to its original operation; settlement must not consume the new week's allowance twice or manufacture rollover. Duplicate client requests and payment events settle once.

A visual quote is an atomic paid stage: capture its credits only when the full usable stage output is saved. A partial failure while producing the remaining slides or assembling their result releases the entire failed stage's customer reservation, not an arbitrary per-slide fraction. Earlier completed preparation/cover stages and their charges remain intact. Preparation that delivers no usable first reply releases its reservation; an activated preparation package follows the disclosed package policy above. Retain actual provider spend as a business expense in every failure case. Model/network uncertainty is not proof of failure. Do not retry uncertain paid requests automatically; retain exposure and reconcile them.

## Margin validation

Price every action using a conservative, bounded input/output/attempt envelope. Internal formulation: action credits = ceiling(conservative action cost / internal cost budget per credit). Measure actual costs but do not call the largest observed sample a guaranteed upper bound.

Evaluate the lowest net revenue per credit across both tiers, annual discounts and packs, after payment/Billing fees, relevant taxes and expected operational contingency. Model full allowance consumption; unused credits improve results but must not be required to avoid routine losses. Weekly grants can occur five times in a monthly paid period or 53 times in an initial annual period. Never model every month as exactly four weeks.

Liquidity, revenue, gross margin and profit are different. Upfront annual payment is not immediately earned profit or a guarantee of cash availability. Refunds, chargebacks, provider billing and later serving obligations remain risks. No honest architecture can promise zero financial loss.

Sandbox catalog amounts must be explicitly provisional, isolated from production, and not presented as an approved commercial offer. Actual prices and quotas are an output of the benchmark stage, reviewed before any sale.

## Development hard ceiling

USD 10 total for all real API usage during the entire development effort, including founder local tests, every agent, failures and retries. No automatic recharge, alternate key, per-worktree reset or off-ledger live call.

Use one persistent budget counter outside resettable test data, serialized before provider dispatch. Keep outstanding maximum-cost reservations until actual costs are known. A fixture database reset or restart must preserve both actual spend and unresolved exposure. Missing/corrupt state after initial budget activation must block spending, never silently recreate a zero balance. Disable SDK automatic retries for paid generation. Keep live concurrency at one. If an action lacks a defensible upper envelope or remaining budget, refuse before dispatch. Unknown charges block further spending when they could breach the ceiling.

Suggested stage envelopes, not spending targets: context/dialogue USD 1; style trials USD 2; complete samples USD 3; revisions/repeatability USD 2; errors/final checks USD 2. Coordinator may reallocate inside USD 10. More spending requires the founder's explicit approval.

Default configuration is fixture mode and live disabled. A key's presence alone must never enable spending. Do not claim the hard guard exists until its implementation and race/failure tests pass.

## Billing integration

Use Stripe Checkout, Billing and customer portal in Sandbox/test mode, with fixed-price subscriptions and internally managed credits. Test signatures against the raw webhook body; verify events server-side. Never grant access based on a browser success redirect. Reconcile duplicate/out-of-order events against server-side payment/subscription state.

A local billing simulator is useful for development but is not Stripe integration evidence. No real products, charges, subscriptions, tax configuration, seller entity or production webhook setup without the required founder approval. A hosted metering service is not required for the local fixed-subscription allowance model.
