import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { CostEvidence, OperationKind, Platform, PublicationView, QuoteView } from "../shared/contracts";
import { pool, transaction } from "./db";
import { lockWallet, requireEntitlement, reserveCredits, type Viewer } from "./credits";
import { AppError, requireCondition } from "./errors";
import { enqueueOperation } from "./queue";
import { fixtureRevisionTarget } from "./fixture-provider";
import { inputHash, snapshotPaidInput, verifyPaidInput } from "./paid-input";
import { generationMode } from "./config";
import { currentPreparation, preparationView } from "./preparation";
import { interpretRevision } from "./revision-scope";
import type { TextModel } from "./providers/text-envelope";
import { validateComposedCopy } from "./renderer";
import { generationRequest } from "./providers/generation";
import { assertCurrentBrand, freezeBrand, readBrand, verifyFrozenBrand } from "./brand";
import { assertBrandReady, brandReadiness, selectedPalette } from "./brand-policy";
import type { PublicationBrief } from "../shared/brand";
import { freezeArtDirection, withoutHeroImages } from "./art-direction";
import { semanticTones, visualGrammars } from "../shared/semantic-direction";
import { semanticArtDirection, semanticDirectionEligibility, validateSemanticDirection } from "./semantic-direction";

export function missingDiscountTerms(idea: string) {
  const mentionsDiscount = /discounts?|скид(?:ка|ки|ку|ок|кам|ками|ках)|rabatt(?:e|en|s)?/iu.test(idea);
  const negatesDiscount = /(?:\bno\b|\bwithout\b|\bnot offering\b|\bno\s+discounts?\b|\bohne\b|\bkeine[nmr]?\b|без|не\s+(?:даем|даём|предлагаем))[^.!?\n]{0,32}(?:discounts?|скид(?:ка|ки|ку|ок|кам|ками|ках)|rabatt(?:e|en|s)?)/iu.test(idea);
  return mentionsDiscount && !negatesDiscount && !/\d/u.test(idea);
}

export async function readPublication(ownerId: string, id: string, client: PoolClient | typeof pool = pool, lock = false): Promise<PublicationView> {
  const { rows: [row] } = await client.query<{ state: PublicationView }>(`SELECT state FROM publication WHERE id=$1 AND owner_id=$2${lock ? " FOR UPDATE" : ""}`, [id, ownerId]);
  requireCondition(row, "not_found", "That publication is not available.", 404);
  row.state.origin ??= "fixture";
  if (row.state.brandBrief) row.state.readiness = brandReadiness(row.state, await freezeBrand(ownerId, row.state, client));
  const preparation = await currentPreparation(ownerId, id, client);
  if (preparation) row.state.preparation = preparationView(preparation);
  if (row.state.history.some((entry) => entry.canExportImages === undefined || entry.canExportCaption === undefined)) {
    const { rows: snapshots } = await client.query<{ version: number; can_images: boolean; can_caption: boolean }>("SELECT version,coalesce((state->>'caption')<>'',false) AS can_caption,jsonb_array_length(state->'slides')>0 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(state->'slides') s WHERE NOT (s ? 'assetId')) AS can_images FROM publication_version WHERE publication_id=$1", [id]);
    const availability = new Map(snapshots.map((snapshot) => [snapshot.version, snapshot]));
    row.state.history = row.state.history.map((entry) => ({ ...entry, canExportImages: availability.get(entry.version)?.can_images ?? false, canExportCaption: availability.get(entry.version)?.can_caption ?? false }));
  }
  return row.state;
}

export async function writePublication(client: PoolClient, state: PublicationView, label: string, cost?: CostEvidence) {
  state.version += 1;
  state.updatedAt = new Date().toISOString();
  state.history.push({ version: state.version, createdAt: state.updatedAt, label, origin: state.origin ?? "fixture", ...(cost ? { cost } : {}), canExportImages: state.slides.length > 0 && state.slides.every((slide) => Boolean(slide.assetId)), canExportCaption: Boolean(state.caption) });
  await client.query("UPDATE publication SET state=$2,version=$3,updated_at=now() WHERE id=$1", [state.id, JSON.stringify(state), state.version]);
  await client.query("INSERT INTO publication_version(publication_id,version,state) VALUES($1,$2,$3)", [state.id, state.version, JSON.stringify(state)]);
  return state;
}

function assertVersion(state: PublicationView, version: number) {
  requireCondition(state.version === version, "stale_version", "This post changed. Refresh the current version before continuing.", 409);
  requireCondition(!state.pendingOperation, "operation_in_progress", "Wait for the current operation before changing this post.", 409);
}

async function assertReconciled(client: PoolClient, ownerId: string, publicationId: string) {
  const unresolved = await client.query("SELECT id FROM operation WHERE owner_id=$1 AND publication_id=$2 AND status='uncertain' LIMIT 1", [ownerId, publicationId]);
  requireCondition(unresolved.rowCount === 0, "attempt_uncertain", "This publication has an unresolved provider attempt. Its exposure is retained; coordinator reconciliation is required before any new quoted action.", 409);
}

export function inferLanguage(idea: string, explicit?: string) {
  if (explicit?.trim()) return explicit.trim().toLowerCase();
  if (/[а-яё]/iu.test(idea)) return "ru";
  if (/\b(wir|unser|unsere|ein|eine|möchte|für|über)\b|[äöüß]/iu.test(idea)) return "de";
  return "en";
}

export async function createPublication(viewer: Viewer, input: { idea: string; platform: Platform; slideCount: number; language?: string; sourceAnalysisId?: string }) {
  return transaction(async (client) => {
    const wallet = await lockWallet(client, viewer.id);
    await requireEntitlement(client, wallet);
    const now = new Date().toISOString();
    const brand = await readBrand(viewer.id, client);
    let sourceAnalysis: PublicationView["sourceAnalysis"];
    if (input.sourceAnalysisId) {
      const selected = (await client.query("SELECT a.id,a.origin,a.proposal FROM brand_analysis a JOIN operation o ON o.id=a.operation_id WHERE a.owner_id=$1 AND a.id=$2 AND o.status='completed'", [viewer.id, input.sourceAnalysisId])).rows[0];
      requireCondition(selected?.proposal, "analysis_unavailable", "Select a completed analysis from your own Brand workspace.", 404);
      sourceAnalysis = { id: selected.id, origin: selected.origin, summary: selected.proposal.summary, observations: selected.proposal.observations, limitations: selected.proposal.limitations };
    }
    const state: PublicationView = {
      fixture: true, origin: "fixture", id: randomUUID(), title: input.idea.slice(0, 72), idea: input.idea,
      designPolicy: generationMode() === "fixture" ? "art-direction-v1" : "creative-intent-v9",
      ...(sourceAnalysis ? { sourceAnalysis } : {}),
      platform: input.platform, language: inferLanguage(input.idea, input.language), slideCount: input.slideCount,
      status: "collecting", version: 1, outlineApproved: false, coverApproved: false, caption: "", slides: [],
      brandBrief: { audience: brand.rules.audience, direction: brand.rules.palette ?? (brand.rules.sourceStrategy === "decide_for_me" ? "decide" : null), requiredMaterialIds: [], noPhoto: false, blockingFacts: missingDiscountTerms(input.idea) ? ["Discount amount or offer terms have not been provided."] : [], factResolution: "" },
      messages: [
        { id: randomUUID(), role: "user", text: input.idea, createdAt: now },
        { id: randomUUID(), role: "assistant", text: "I’ll use your idea and saved brand. Add anything important, or review preparation. Linked sources are not fetched automatically.", createdAt: now },
      ],
      history: [{ version: 1, createdAt: now, label: "Idea saved" }], createdAt: now, updatedAt: now,
    };
    await client.query("INSERT INTO publication(id,owner_id,state,version) VALUES($1,$2,$3,1)", [state.id, viewer.id, JSON.stringify(state)]);
    await client.query("INSERT INTO publication_version(publication_id,version,state) VALUES($1,1,$2)", [state.id, JSON.stringify(state)]);
    return state;
  });
}

export async function updatePublicationBrief(viewer: Viewer, id: string, version: number, brief: PublicationBrief) {
  return transaction(async (client) => {
    await requireEntitlement(client, await lockWallet(client, viewer.id));
    const state = await readPublication(viewer.id, id, client, true);
    assertVersion(state, version);
    requireCondition(!state.outlineApproved && !state.preparation?.closed, "brief_locked", "This brief is locked after content approval. Start a new post to change its requirements.", 409);
    const previous = state.brandBrief;
    if (previous?.direction !== brief.direction) {
      delete state.brandPalette;
      state.slides = state.slides.map(({ palette: _palette, ...slide }) => slide);
    }
    const resolved = Boolean(previous?.blockingFacts.some((fact) => !brief.blockingFacts.includes(fact)));
    requireCondition(!resolved || brief.factResolution.trim().length > 0, "fact_resolution_required", "Record the supplied facts or explicitly explain which claim is being omitted.", 409);
    state.brandBrief = brief;
    delete state.directionProposal;
    if (brief.noPhoto && !previous?.noPhoto && state.artDirection) {
      state.artDirection = freezeArtDirection(withoutHeroImages(state.artDirection.direction), (await readBrand(viewer.id, client)).materials, true);
    }
    const brand = await freezeBrand(viewer.id, state, client);
    for (const materialId of brief.requiredMaterialIds) requireCondition(brand.materials.some((item) => item.id === materialId), "material_missing", "A selected material is unavailable or belongs to another owner.", 409);
    if (resolved || brief.factResolution !== previous?.factResolution) {
      state.messages.push({ id: randomUUID(), role: "user", text: `Fact resolution (user statement; not independently verified): ${brief.factResolution}`, createdAt: new Date().toISOString() });
      state.status = "collecting";
      state.outlineApproved = false;
      state.coverApproved = false;
    }
    state.readiness = brandReadiness(state, brand);
    return writePublication(client, state, "Post-local brief updated; standing brand unchanged");
  });
}

export async function listPublications(ownerId: string) {
  const { rows } = await pool.query<{ state: PublicationView }>("SELECT state FROM publication WHERE owner_id=$1 ORDER BY updated_at DESC LIMIT 100", [ownerId]);
  return { publications: rows.map((row) => row.state) };
}

export async function addMessage(viewer: Viewer, id: string, text: string, version: number) {
  return transaction(async (client) => {
    await lockWallet(client, viewer.id);
    const state = await readPublication(viewer.id, id, client, true);
    assertVersion(state, version);
    requireCondition((state.status === "collecting" || state.status === "content_approval" || (state.status === "failed" && state.failedOperationKind === "prepare")) && !state.outlineApproved && !state.preparation?.closed, "quote_revision", "Use a quoted chat revision after content approval.", 409);
    requireCondition(state.messages.length < 30, "context_limit", "This fixture has reached its context limit. Start a new post.");
    state.messages.push({ id: randomUUID(), role: "user", text, createdAt: new Date().toISOString() });
    delete state.directionProposal;
    state.status = "collecting";
    state.outlineApproved = false;
    state.coverApproved = false;
    return writePublication(client, state, "Context added");
  });
}

export async function approvePublication(viewer: Viewer, id: string, stage: "content" | "cover", version: number) {
  return transaction(async (client) => {
    await lockWallet(client, viewer.id);
    const state = await readPublication(viewer.id, id, client, true);
    assertVersion(state, version);
    requireCondition(!state.creation, "unified_creation", "This complete creation does not need separate stage approvals.", 409);
    if (stage === "content") {
      if (state.brandBrief) assertBrandReady(state, await freezeBrand(viewer.id, state, client));
      requireCondition(state.status === "content_approval" && state.slides.length > 0, "wrong_stage", "Prepare the current content before approving it.", 409);
      if (state.outlineApproved) return state;
      if (state.directionProposal?.status === "pending") {
        const proposal = state.directionProposal.direction;
        validateSemanticDirection({ mode: "propose", tone: proposal.tone, grammar: proposal.grammar, ...proposal.palette, headingFont: proposal.headingFont, spacing: proposal.spacing, rationale: proposal.rationale }, "propose");
        const bound = await client.query<{ input_snapshot: { brand?: { version?: number } } }>("SELECT input_snapshot FROM operation WHERE id=$1 AND owner_id=$2 AND publication_id=$3 AND status='completed' AND input_hash=$4", [state.directionProposal.operationId, viewer.id, id, state.directionProposal.inputHash]);
        requireCondition(bound.rowCount === 1, "direction_proposal_stale", "The displayed visual direction is not bound to this completed preparation. Prepare a current proposal before approval.", 409);
        requireCondition(Number.isInteger(bound.rows[0].input_snapshot.brand?.version), "direction_proposal_stale", "The displayed visual direction has no valid Brand binding.", 409);
        await assertCurrentBrand(viewer.id, bound.rows[0].input_snapshot.brand!.version!, client);
        state.directionProposal = { ...state.directionProposal, status: "accepted", acceptedAt: new Date().toISOString() };
        state.artDirection = semanticArtDirection(state.directionProposal.direction);
      }
      const composed = state.artDirection ? state.slides : state.slides.filter((slide) => slide.copyOrigin && slide.copyOrigin !== "fixture");
      if (composed.length) await validateComposedCopy({ ...state, slides: composed });
      state.outlineApproved = true;
      await client.query("UPDATE preparation_package SET closed=true WHERE owner_id=$1 AND publication_id=$2 AND NOT closed", [viewer.id, id]);
      if (state.preparation) state.preparation.closed = true;
    } else {
      requireCondition(state.status === "cover_approval" && state.slides[0]?.assetId, "wrong_stage", "Generate a cover before approving its style.", 409);
      state.coverApproved = true;
      state.status = state.slides.every((slide) => slide.assetId) ? "ready" : "cover_approved";
    }
    return writePublication(client, state, stage === "content" ? "Content approved" : "Cover approved");
  });
}

export async function quoteOperation(viewer: Viewer, id: string, kind: OperationKind, version: number, instruction = "", selectedModel?: TextModel): Promise<QuoteView> {
  return transaction(async (client) => {
    const wallet = await lockWallet(client, viewer.id);
    await requireEntitlement(client, wallet);
    const state = await readPublication(viewer.id, id, client, true);
    requireCondition(!state.creation, "unified_creation", "Use the complete creation or a complete-result revision; stages are not purchased separately.", 409);
    assertVersion(state, version);
    const activePackage = kind === "prepare" ? await currentPreparation(viewer.id, id, client, true) : undefined;
    await assertReconciled(client, viewer.id, id);
    const continuing = activePackage && !activePackage.closed && activePackage.replies_used < 3 ? activePackage : undefined;
    const origin = continuing?.origin ?? generationMode();
    const model = (continuing?.model ?? selectedModel ?? "gpt-5.6-luna") as TextModel;
    requireCondition(model === "gpt-5.6-luna" || model === "gpt-5.6-terra", "model_unavailable", "That internal model selection is not approved.");
    requireCondition(!selectedModel || !continuing || selectedModel === continuing.model, "package_model_fixed", "Included replies use the model and price from their accepted package.", 409);
    if (continuing) requireCondition(!continuing.paused && continuing.attempts_used < 4, "package_paused", "This preparation package needs local coordinator review. Your work and remaining replies are preserved; do not buy another package to remedy this failure.", 409);
    if (kind === "prepare") requireCondition(["collecting", "content_approval", "failed"].includes(state.status) && !state.outlineApproved && !state.preparation?.closed, "wrong_stage", "Preparation ends at content approval. Use a scoped revision afterward.", 409);
    if (kind === "cover") requireCondition(state.outlineApproved && state.directionProposal?.status !== "pending" && ["content_approval", "cover_approval", "failed"].includes(state.status), "content_approval_required", "Approve this content and visual direction before generating a cover.", 409);
    if (kind === "remaining") requireCondition(state.coverApproved && state.slideCount > 1 && ["cover_approved", "failed"].includes(state.status), "cover_approval_required", "Approve the cover before generating the remaining slides.", 409);
    const scope = kind === "revise" && origin !== "fixture" ? interpretRevision(state, instruction) : undefined;
    if (kind === "revise") requireCondition((["ready", "cover_approval"].includes(state.status) || (state.status === "failed" && state.failedOperationKind === "revise") || (state.status === "content_approval" && state.pendingVisualTargets?.length)) && instruction.trim(), "revision_unavailable", "Describe a revision to completed or revised copy.", 409);
    if (scope?.kind === "compose") requireCondition(state.outlineApproved && state.pendingVisualTargets?.includes(scope.target), "content_approval_required", "Approve the revised copy before composing this slide.", 409);
    if (scope?.kind === "style") requireCondition(state.outlineApproved && state.slides[scope.target - 1]?.assetId, "content_approval_required", "Approve and compose the copy before a style revision.", 409);
    if (scope?.kind === "plan") requireCondition(state.outlineApproved && state.slides[scope.target - 1]?.assetId, "content_approval_required", "Approve and compose the current content before requesting a new visual plan.", 409);
    const textPrice = model === "gpt-5.6-terra" ? 30 : 3;
    const credits = kind === "prepare" ? (continuing?.activated ? 0 : origin === "fixture" ? 3 : textPrice) : kind === "remaining" ? 8 * (state.slideCount - 1) : scope?.kind === "copy" || scope?.kind === "plan" ? textPrice : scope?.kind === "style" ? textPrice + 8 : 8;
    const quote: QuoteView = {
      id: randomUUID(), publicationId: id, kind, version, credits, fixture: origin !== "openai", origin, model,
      summary: kind === "prepare" ? "Prepare a deterministic sample outline and caption; no AI is called." : kind === "cover" ? "Create one fixture cover for style approval." : kind === "remaining" ? `Create all ${state.slideCount - 1} remaining fixture slides as one stage.` : `Change the fixture color treatment on slide ${fixtureRevisionTarget(state, instruction) + 1}; approved copy stays unchanged. Your request: ${instruction}`,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    };
    if (origin !== "fixture") {
      quote.summary = kind === "prepare" ? `${continuing?.activated ? "Use one included preparation reply" : "Activate preparation: up to 3 useful replies, charged when the first is saved"}. At most 4 provider attempts including one explicit retry; no automatic retry. Content approval closes preparation. ${origin === "ai_preview" ? "Fake Responses preview: no real AI call." : "Bounded OpenAI text request."}` : scope ? `${scope.kind === "copy" ? "Revise copy" : scope.kind === "style" ? `Adjust only ${state.designPolicy ? "the four brand palette roles" : "the color palette (indigo, forest, rose or sand)"}, preserving approved copy, imagery, layout and typeface` : "Compose approved copy"} on slide ${scope.target}. Your request: ${instruction}` : `Compose ${kind === "cover" ? "one cover" : `${state.slideCount - 1} remaining slides`} from approved copy with measured typography. No image model is called.`;
      if (kind === "prepare") quote.preparation = { included: Boolean(continuing?.activated), maximumReplies: 3, repliesRemaining: continuing ? 3 - continuing.replies_used : 3, activatesOnFirstUsableReply: !continuing?.activated };
      if (scope) quote.scope = scope;
      if (scope?.kind === "plan") quote.summary = `Propose a new visual plan for slide ${scope.target}: ${credits} credits now, then a separate 8-credit composition only after you approve (${credits + 8} total if composed). Preserve copy, caption, font, palette and other slides; use only previously selected originals. Your request: ${instruction}`;
    }
    const { rows: [business] } = await client.query("SELECT name,context,website FROM business WHERE owner_id=$1", [viewer.id]);
    const snapshot = snapshotPaidInput(viewer.id, quote.id, kind, instruction, state, business);
    snapshot.generation = { origin, model, ...(scope ? { scope } : {}) };
    if (state.brandBrief) {
      snapshot.schemaVersion = 2;
      snapshot.brand = await freezeBrand(viewer.id, state, client);
      if (snapshot.brand.art) {
        snapshot.schemaVersion = state.designPolicy === "creative-intent-v9" ? 12 : state.designPolicy === "creative-intent-v8" ? 11 : state.designPolicy === "creative-intent-v7" ? 10 : state.designPolicy === "creative-intent-v6" ? 9 : state.designPolicy === "creative-intent-v5" ? 8 : state.designPolicy === "creative-intent-v4" ? 7 : state.designPolicy === "creative-intent-v3" ? 6 : state.designPolicy === "creative-intent-v2" ? 5 : state.designPolicy === "creative-intent-v1" ? 4 : 3;
        if (snapshot.schemaVersion === 12) snapshot.semanticDirection = { mode: semanticDirectionEligibility(snapshot), allowedTones: [...semanticTones], allowedGrammars: [...visualGrammars], inherited: snapshot.brand.art.direction };
        snapshot.publication.artDirection = snapshot.brand.art;
      }
      await verifyFrozenBrand(viewer.id, snapshot.brand, client);
      const palette = state.brandPalette ?? selectedPalette(snapshot.brand);
      snapshot.publication.brandPalette = palette;
      if (kind === "cover" || kind === "remaining" || (kind === "revise" && !["copy", "plan"].includes(scope?.kind ?? ""))) assertBrandReady(state, snapshot.brand);
      quote.brand = { version: snapshot.brand.version, palette, ...(snapshot.brand.art ? { artDirection: snapshot.brand.art.direction } : {}), notice: snapshot.brand.art ? "Approved palette, bundled typeface, composition and selected original images are frozen in this quote. References are not reusable originals." : "Palette applies to new visuals. Images and headline memory are saved, not analyzed/placed or applied to copy." };
    }
    if (origin !== "fixture" && (kind === "prepare" || (kind === "revise" && scope?.kind !== "compose"))) {
      try { generationRequest(snapshot); } catch { throw new AppError("context_limit", "This conversation exceeds the safe request limit. Shorten the context or start a new post; no credits were reserved.", 422); }
    }
    await client.query("INSERT INTO quote(id,owner_id,publication_id,kind,publication_version,credits,instruction,expires_at,business_context,input_snapshot,input_hash,origin,model,scope,package_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)", [quote.id, viewer.id, id, kind, version, credits, instruction, quote.expiresAt, JSON.stringify(snapshot.business), JSON.stringify(snapshot), inputHash(snapshot), origin, model, scope ? JSON.stringify(scope) : null, continuing?.id ?? null]);
    return quote;
  });
}

export async function acceptQuote(viewer: Viewer, id: string, requestKey: string) {
  const routed = (await pool.query("SELECT kind FROM quote WHERE id=$1 AND owner_id=$2", [id, viewer.id])).rows[0];
  if (routed?.kind === "create") return (await import("./creation")).acceptCreation(viewer, id, requestKey);
  const result = await transaction(async (client) => {
    const wallet = await lockWallet(client, viewer.id);
    const { rows: [quote] } = await client.query("SELECT * FROM quote WHERE id=$1 AND owner_id=$2 FOR UPDATE", [id, viewer.id]);
    requireCondition(quote, "not_found", "That quote is not available.", 404);
    requireCondition(quote.kind !== "create", "unified_creation", "Accept this quote through complete creation.", 409);
    if (quote.accepted_operation_id) return { operationId: quote.accepted_operation_id as string, publicationId: quote.publication_id as string };
    const { rows: [previous] } = await client.query("SELECT id,quote_id FROM operation WHERE owner_id=$1 AND request_key=$2", [viewer.id, requestKey]);
    requireCondition(!previous, "idempotency_conflict", "That request key was already used for another quote.", 409);
    requireCondition(new Date(quote.expires_at).getTime() > Date.now(), "quote_expired", "This quote expired. Request a current quote.", 409);
    await requireEntitlement(client, wallet);
    const state = await readPublication(viewer.id, quote.publication_id, client, true);
    await assertReconciled(client, viewer.id, state.id);
    assertVersion(state, quote.publication_version);
    requireCondition(quote.input_snapshot && quote.input_hash, "quote_snapshot_required", "This older quote needs to be requested again.", 409);
    const snapshot = verifyPaidInput(quote.input_snapshot, quote.input_hash);
    if (snapshot.schemaVersion >= 2 && snapshot.brand) {
      await assertCurrentBrand(viewer.id, snapshot.brand.version, client);
      await verifyFrozenBrand(viewer.id, snapshot.brand, client);
      if (quote.kind === "cover" || quote.kind === "remaining" || (quote.kind === "revise" && !["copy", "plan"].includes(quote.scope?.kind ?? ""))) assertBrandReady(snapshot.publication, snapshot.brand);
    }
    requireCondition(snapshot.ownerId === viewer.id && snapshot.quoteId === id && snapshot.publication.id === state.id && snapshot.publication.version === state.version, "quote_snapshot_conflict", "This quote's saved inputs are inconsistent.", 409);
    const operationId = randomUUID();
    let packageId: string | null = quote.package_id;
    if (quote.origin !== "fixture" && quote.kind === "prepare") {
      const current = await currentPreparation(viewer.id, state.id, client, true);
      if (packageId) requireCondition(current?.id === packageId && !current.closed && !current.paused && current.replies_used < 3 && current.attempts_used < 4 && (current.activated ? quote.credits === 0 : quote.credits > 0), "package_changed", "This package changed. Review the current included reply or quote.", 409);
      else {
        requireCondition(!current || current.closed || current.replies_used === 3, "package_changed", "Continue the existing preparation package.", 409);
        if (current) await client.query("UPDATE preparation_package SET closed=true WHERE id=$1", [current.id]);
        packageId = randomUUID();
        await client.query("INSERT INTO preparation_package(id,owner_id,publication_id,origin,model) VALUES($1,$2,$3,$4,$5)", [packageId, viewer.id, state.id, quote.origin, quote.model]);
      }
      await client.query("UPDATE preparation_package SET attempts_used=attempts_used+1 WHERE id=$1", [packageId]);
    }
    await client.query("INSERT INTO operation(id,owner_id,publication_id,quote_id,request_key,kind,status,input_state,instruction,business_context,input_snapshot,input_hash,origin,model,scope,package_id) VALUES($1,$2,$3,$4,$5,$6,'queued',$7,$8,$9,$10,$11,$12,$13,$14,$15)", [operationId, viewer.id, state.id, id, requestKey, quote.kind, JSON.stringify(snapshot.publication), quote.instruction, JSON.stringify(snapshot.business), JSON.stringify(snapshot), quote.input_hash, quote.origin, quote.model, quote.scope ? JSON.stringify(quote.scope) : null, packageId]);
    if (quote.credits > 0) await reserveCredits(client, wallet, operationId, quote.credits);
    await client.query("UPDATE quote SET accepted_operation_id=$2 WHERE id=$1", [id, operationId]);
    state.pendingOperation = { id: operationId, kind: quote.kind, status: "queued", origin: quote.origin };
    state.status = "running";
    await writePublication(client, state, `${quote.origin === "fixture" ? "Fixture" : quote.origin === "ai_preview" ? "AI-flow preview" : "OpenAI"} action accepted`);
    return { operationId, publicationId: state.id };
  });
  try { await enqueueOperation(result.operationId); } catch { /* The worker repairs durable queued operations after a queue outage. */ }
  return result;
}
