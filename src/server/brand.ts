import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { BrandEvent, BrandField, BrandImportResult, BrandMaterial, BrandRules, BrandSource, BrandSourceOutcomeCode, BrandSourceState, BrandValue, BrandView, FrozenBrand, PublicationBrief, SourceBundleView, SourceStrategy } from "../shared/brand";
import type { PublicationView } from "../shared/contracts";
import { pool, transaction } from "./db";
import { lockWallet, requireEntitlement, type Viewer } from "./credits";
import { requireCondition } from "./errors";
import { defaultBrandRules, interpretMemory, sourceCompleteness } from "./brand-policy";
import { discardMaterial, materialBytes, normalizeMaterial, storeMaterial } from "./brand-materials";
import { canonicalJson, inputHash } from "./paid-input";
import { freezeArtDirection, validateArtDirection, withoutHeroImages } from "./art-direction";
import { defaultArtDirection } from "./brand-policy";
import { acquirePublicReferences } from "./source-acquisition";

type Client = PoolClient | typeof pool;
type MaterialRow = { id: string; role: BrandMaterial["role"]; kind: BrandMaterial["kind"]; label: string; source_url: string | null; version: number; content_hash: string | null; width: number | null; height: number | null; bytes: number; created_at: Date; stored_name: string | null; source_id: string | null };
function materialView(row: MaterialRow): BrandMaterial {
  return { id: row.id, role: row.role, kind: row.kind, label: row.label, sourceUrl: row.source_url, version: row.version, contentHash: row.content_hash, width: row.width, height: row.height, bytes: row.bytes, createdAt: row.created_at.toISOString(), sourceId: row.source_id };
}

export async function readBrand(ownerId: string, client: Client = pool): Promise<BrandView> {
  const { rows: [brand] } = await client.query<{ version: number; state: BrandRules }>("SELECT version,state FROM brand_workspace WHERE owner_id=$1", [ownerId]);
  const { rows: materials } = await client.query<MaterialRow>("SELECT * FROM brand_material WHERE owner_id=$1 AND archived_at IS NULL ORDER BY created_at,id", [ownerId]);
  const { rows: events } = await client.query("SELECT * FROM brand_event WHERE owner_id=$1 ORDER BY resulting_version DESC LIMIT 30", [ownerId]);
  return { version: brand?.version ?? 0, rules: { ...structuredClone(defaultBrandRules), ...(brand?.state ?? {}) }, materials: materials.map(materialView), events: events.map((event): BrandEvent => ({ id: event.id, field: event.field, before: event.before_value, after: event.after_value, version: event.resulting_version, undoOf: event.undo_of, createdAt: event.created_at.toISOString() })) };
}

type SourceRow = { id: string; kind: Exclude<BrandSource["kind"], "legacy">; role: BrandMaterial["role"]; label: string; submitted_url: string | null; canonical_url: string | null; acquisition_state: BrandSourceState; outcome_code: BrandSourceOutcomeCode; fallback_for: string | null; acquired_at: Date | null; created_at: Date };
function sourceView(row: SourceRow, materials: BrandMaterial[]): BrandSource {
  const activeMaterials = materials.filter((material) => material.sourceId === row.id);
  const hasActiveImage = activeMaterials.some((material) => material.kind === "image");
  const state = row.acquisition_state !== "needs_upload" && !hasActiveImage ? "needs_upload" : row.acquisition_state;
  return { id: row.id, kind: row.kind, role: row.role, label: row.label, state, outcomeCode: row.outcome_code, submittedUrl: row.submitted_url, canonicalUrl: row.canonical_url, acquiredAt: row.acquired_at?.toISOString() ?? null, createdAt: row.created_at.toISOString(), fallbackFor: row.fallback_for, materials: activeMaterials };
}

function replayedOutcome(source: BrandSource): BrandImportResult["outcome"] {
  const imported = source.materials.filter((material) => material.kind === "image").length;
  const status = source.state === "available" ? "imported" as const : source.state === "partial" ? "partial" as const : "fallback" as const;
  const message = source.state === "needs_upload" ? "This source did not expose usable visual evidence. Upload selected screenshots instead." : source.state === "partial" ? `Imported ${imported} public preview image${imported === 1 ? "" : "s"}; this source remains partial.` : "Imported one direct public reference image.";
  return { status, imported, message, sourceUrl: source.canonicalUrl ?? source.submittedUrl ?? "" };
}

export async function readSourceBundle(ownerId: string, client: Client = pool, requirements: { requiredMaterialIds?: string[]; exactOriginalRequired?: boolean } = {}): Promise<SourceBundleView> {
  const brand = await readBrand(ownerId, client);
  const rows = (await client.query<SourceRow>("SELECT id,kind,role,label,submitted_url,canonical_url,acquisition_state,outcome_code,fallback_for,acquired_at,created_at FROM brand_source WHERE owner_id=$1 AND archived_at IS NULL ORDER BY created_at,id", [ownerId])).rows;
  const sources = rows.map((row) => sourceView(row, brand.materials));
  const legacy = brand.materials.filter((item) => !item.sourceId);
  for (const material of legacy) {
    const hasAcquiredPeer = material.kind === "link" && Boolean(material.sourceUrl) && legacy.some((peer) => peer.kind === "image" && peer.sourceUrl === material.sourceUrl);
    sources.push({ id: material.id, kind: "legacy", role: material.role, label: material.label, state: material.kind === "image" ? "available" : hasAcquiredPeer ? "partial" : "needs_upload", outcomeCode: "legacy_material", submittedUrl: material.sourceUrl, canonicalUrl: material.sourceUrl, acquiredAt: material.createdAt, createdAt: material.createdAt, fallbackFor: null, materials: [material] });
  }
  const eventByField = new Map<BrandField, BrandEvent>();
  for (const item of brand.events) if (!eventByField.has(item.field)) eventByField.set(item.field, item);
  const preferences: SourceBundleView["preferences"] = [];
  for (const field of ["audience", "voice", "palette", "headlines", "artDirection", "sourceStrategy"] as BrandField[]) {
    const value = brand.rules[field as keyof BrandRules] as BrandValue | undefined;
    if (value !== undefined && value !== null && value !== "" && !(field === "headlines" && value === "default")) preferences.push({ field, state: "confirmed", value, evidence: "user", ...(eventByField.get(field) ? { eventId: eventByField.get(field)!.id } : {}) });
  }
  const proposals = await client.query<{ id: string; proposal: { direction?: BrandValue } }>("SELECT a.id,a.proposal FROM brand_analysis a JOIN operation o ON o.id=a.operation_id WHERE a.owner_id=$1 AND a.applied=false AND a.proposal IS NOT NULL AND o.status='completed' ORDER BY a.created_at DESC LIMIT 5", [ownerId]);
  for (const proposal of proposals.rows) if (proposal.proposal.direction) preferences.push({ field: "artDirection", state: "proposed", value: proposal.proposal.direction, evidence: "analysis", analysisId: proposal.id });
  const completeness = sourceCompleteness(sources, brand.rules.sourceStrategy ?? null, requirements);
  const exact = brand.materials.filter((material) => material.kind === "image" && material.role === "original").length;
  const references = brand.materials.filter((material) => material.kind === "image" && material.role === "reference").length;
  const learned = [...(exact ? [`${exact} exact original${exact === 1 ? "" : "s"}`] : []), ...(references ? [`${references} visual reference${references === 1 ? "" : "s"}`] : []), ...(preferences.some((item) => item.state === "confirmed") ? ["confirmed Brand preferences"] : [])];
  const unavailable = sources.filter((source) => source.state === "needs_upload").map((source) => `${source.label} needs uploaded screenshots`);
  const proposed = preferences.filter((item) => item.state === "proposed").map(() => "A reference analysis direction is ready for review");
  const unresolvedSocial = completeness.recommendations.some((gap) => gap.code === "social_screenshots_recommended");
  const nextAction = completeness.blockers.length ? "add_material" : unresolvedSocial ? "upload_screenshots" : proposed.length ? "review_proposal" : completeness.selectableAnalysisMaterialIds.length && !brand.rules.artDirection ? "analyze_references" : "continue";
  return { brandVersion: brand.version, strategy: brand.rules.sourceStrategy ?? null, sources, preferences, completeness, summary: { learned, unavailable, proposed, nextAction } };
}

async function lockBrand(client: PoolClient, viewer: Viewer) {
  await requireEntitlement(client, await lockWallet(client, viewer.id));
  await client.query("INSERT INTO brand_workspace(owner_id) VALUES($1) ON CONFLICT DO NOTHING", [viewer.id]);
  return (await client.query<{ version: number; state: BrandRules }>("SELECT version,state FROM brand_workspace WHERE owner_id=$1 FOR UPDATE", [viewer.id])).rows[0];
}
export async function requireBrandAccess(viewer: Viewer) { await transaction(async (client) => { await requireEntitlement(client, await lockWallet(client, viewer.id)); }); }
function assertBrandVersion(actual: number, expected: number) { requireCondition(actual === expected, "brand_changed", "Your brand changed. Refresh before applying this change or accepting the quote.", 409); }

async function event(client: PoolClient, ownerId: string, current: { version: number; state: BrandRules }, field: BrandField, value: BrandValue, commandKey: string, undoOf: string | null = null) {
  await client.query("INSERT INTO brand_event(id,owner_id,base_version,resulting_version,field,before_value,after_value,undo_of,command_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [randomUUID(), ownerId, current.version, current.version + 1, field, canonicalJson(current.state[field] ?? null), canonicalJson(value), undoOf, commandKey]);
  await client.query("UPDATE brand_workspace SET version=version+1,state=jsonb_set(state,ARRAY[$2]::text[],$3::jsonb),updated_at=now() WHERE owner_id=$1", [ownerId, field, JSON.stringify(value)]);
}

export async function updateBrandRule(viewer: Viewer, input: { field: BrandField; value: BrandValue; version: number; commandKey: string }) {
  return transaction((client) => updateBrandRuleInTransaction(client, viewer, input));
}

export async function updateBrandRuleInTransaction(client: PoolClient, viewer: Viewer, input: { field: BrandField; value: BrandValue; version: number; commandKey: string }) {
  const scalar = typeof input.value === "string" ? input.value : "";
  requireCondition(input.field === "artDirection" ? input.value === null || typeof input.value === "object" : input.field === "audience" || input.field === "voice" ? typeof input.value === "string" && input.value.length <= 500 : input.field === "palette" ? input.value === null || ["indigo", "forest", "rose", "sand"].includes(scalar) : input.field === "headlines" ? ["default", "shorter"].includes(scalar) : input.field === "sourceStrategy" && ["use_materials", "use_preferences", "decide_for_me"].includes(scalar), "invalid_rule", "That typed brand preference is not supported.");
  const value = input.field === "artDirection" && input.value !== null ? validateArtDirection(input.value) : structuredClone(input.value);
    const brand = await lockBrand(client, viewer);
    const previous = (await client.query("SELECT field,after_value,undo_of FROM brand_event WHERE owner_id=$1 AND command_key=$2", [viewer.id, input.commandKey])).rows[0];
    if (previous) requireCondition(previous.field === input.field && canonicalJson(previous.after_value) === canonicalJson(value) && !previous.undo_of, "idempotency_conflict", "This preference command was used for another change.", 409);
    else {
      assertBrandVersion(brand.version, input.version);
      if (input.field === "artDirection" && value !== null) freezeArtDirection(value, (await readBrand(viewer.id, client)).materials, false);
      await event(client, viewer.id, brand, input.field, value, input.commandKey);
    }
    return readBrand(viewer.id, client);
}

export async function updateSourceStrategy(viewer: Viewer, strategy: SourceStrategy, version: number, commandKey: string) {
  await updateBrandRule(viewer, { field: "sourceStrategy", value: strategy, version, commandKey });
  return readSourceBundle(viewer.id);
}

export async function rememberBrand(viewer: Viewer, text: string, version: number, commandKey: string) {
  await requireBrandAccess(viewer);
  let interpretation = interpretMemory(text);
  const existing = await readBrand(viewer.id);
  if (interpretation.status === "durable" && interpretation.field === "palette" && existing.rules.palette && existing.rules.palette !== interpretation.value)
    interpretation = { status: "clarification", effect: `Your standing palette is ${existing.rules.palette}. Is this only for this post, or should it replace the standing palette? Use the explicit palette control to confirm a permanent replacement.` };
  const brand = interpretation.status === "durable" ? await updateBrandRule(viewer, { field: interpretation.field, value: interpretation.value, version, commandKey }) : await readBrand(viewer.id);
  return { interpretation, brand };
}

export async function undoBrand(viewer: Viewer, eventId: string, commandKey: string) {
  return transaction(async (client) => {
    const brand = await lockBrand(client, viewer);
    const previous = (await client.query("SELECT undo_of FROM brand_event WHERE owner_id=$1 AND command_key=$2", [viewer.id, commandKey])).rows[0];
    if (previous) { requireCondition(previous.undo_of === eventId, "idempotency_conflict", "This command was used for another change.", 409); return readBrand(viewer.id, client); }
    const selected = (await client.query("SELECT * FROM brand_event WHERE owner_id=$1 AND id=$2", [viewer.id, eventId])).rows[0];
    requireCondition(selected, "not_found", "That memory update is not available.", 404);
    const later = await client.query("SELECT id FROM brand_event WHERE owner_id=$1 AND field=$2 AND resulting_version>$3 LIMIT 1", [viewer.id, selected.field, selected.resulting_version]);
    requireCondition(!later.rowCount && canonicalJson(brand.state[selected.field as BrandField] ?? null) === canonicalJson(selected.after_value), "undo_conflict", "This preference changed again. Review its current value; Undo would overwrite newer work.", 409);
    await event(client, viewer.id, brand, selected.field, selected.before_value, commandKey, selected.id);
    return readBrand(viewer.id, client);
  });
}

async function checkMaterialQuota(client: PoolClient, ownerId: string, bytes: number, image: boolean) {
  const { rows: [quota] } = await client.query("SELECT count(*)::int AS retained,coalesce(sum(bytes),0)::bigint AS bytes,count(*) FILTER(WHERE kind='image' AND archived_at IS NULL)::int AS active FROM brand_material WHERE owner_id=$1", [ownerId]);
  requireCondition(quota.retained < 100 && Number(quota.bytes) + bytes <= 100 * 1024 * 1024 && (!image || quota.active < 20), "material_quota", "Local storage allows 20 active images, 100 retained records and 100 MiB retained images. Archiving preserves history and does not reset retained storage.", 409);
}

export async function importBrandReferences(viewer: Viewer, input: { label: string; sourceUrl: string; version: number; commandKey?: string }, acquire: (sourceUrl: string) => ReturnType<typeof acquirePublicReferences> = acquirePublicReferences): Promise<BrandImportResult> {
  await requireBrandAccess(viewer);
  if (input.commandKey) {
    const existing = (await pool.query<SourceRow & { submitted_url: string }>("SELECT id,kind,role,label,submitted_url,canonical_url,acquisition_state,outcome_code,fallback_for,acquired_at,created_at FROM brand_source WHERE owner_id=$1 AND command_key=$2", [viewer.id, input.commandKey])).rows[0];
    if (existing) {
      requireCondition(existing.kind !== "upload" && existing.label === input.label && existing.submitted_url === input.sourceUrl, "idempotency_conflict", "This source command was already used for another input.", 409);
      const brand = await readBrand(viewer.id); const bundle = await readSourceBundle(viewer.id); const source = bundle.sources.find((item) => item.id === existing.id)!;
      return { brand, source, bundle, outcome: replayedOutcome(source) };
    }
  }
  assertBrandVersion((await readBrand(viewer.id)).version, input.version);
  const acquired = await acquire(input.sourceUrl);
  const stored: string[] = [];
  let commitPossible = false;
  let persistedSourceId: string | undefined;
  try {
    const brand = await transaction(async (client) => {
      const current = await lockBrand(client, viewer); assertBrandVersion(current.version, input.version);
      await checkMaterialQuota(client, viewer.id, 0, false);
      const sourceId = randomUUID();
      persistedSourceId = sourceId;
      await client.query("INSERT INTO brand_source(id,owner_id,kind,role,label,submitted_url,canonical_url,acquisition_state,outcome_code,resulting_brand_version,acquired_at,command_key) VALUES($1,$2,$3,'reference',$4,$5,$6,$7,$8,$9,$10,$11)", [sourceId, viewer.id, acquired.outcome.kind, input.label, input.sourceUrl, acquired.outcome.sourceUrl, acquired.outcome.state, acquired.outcome.code, current.version + 1, acquired.outcome.state === "needs_upload" ? null : new Date(), input.commandKey ?? null]);
      await client.query("INSERT INTO brand_material(id,owner_id,role,kind,label,source_url,source_id) VALUES($1,$2,'reference','link',$3,$4,$5)", [randomUUID(), viewer.id, `Import source · ${input.label}`.slice(0, 100), acquired.outcome.sourceUrl, sourceId]);
      for (const [index, reference] of acquired.references.entries()) {
        await checkMaterialQuota(client, viewer.id, reference.bytes, true);
        const storedName = await storeMaterial(reference.data);
        stored.push(storedName);
        await client.query("INSERT INTO brand_material(id,owner_id,role,kind,label,source_url,stored_name,mime,bytes,width,height,content_hash,source_id) VALUES($1,$2,'reference','image',$3,$4,$5,'image/png',$6,$7,$8,$9,$10)", [randomUUID(), viewer.id, `${input.label} · reference ${index + 1}`.slice(0, 100), reference.sourceUrl, storedName, reference.bytes, reference.width, reference.height, reference.hash, sourceId]);
      }
      await client.query("UPDATE brand_workspace SET version=version+1,updated_at=now() WHERE owner_id=$1", [viewer.id]);
      const result = await readBrand(viewer.id, client);
      commitPossible = true;
      return result;
    });
    const bundle = await readSourceBundle(viewer.id);
    return { brand, outcome: acquired.outcome, source: bundle.sources.find((source) => source.id === persistedSourceId), bundle };
  } catch (error) {
    if (!commitPossible) await Promise.all(stored.map((name) => discardMaterial(name).catch(() => undefined)));
    throw error;
  }
}

export async function uploadBrandMaterial(viewer: Viewer, input: { bytes: Buffer; label: string; role: "reference" | "original"; version: number; fallbackForSourceId?: string; commandKey?: string }) {
  await requireBrandAccess(viewer);
  if (input.fallbackForSourceId) {
    requireCondition(input.role === "reference", "invalid_fallback", "A screenshot fallback is a reference, not reusable original artwork.");
    const source = (await pool.query("SELECT id FROM brand_source WHERE owner_id=$1 AND id=$2 AND kind IN ('website','social') AND archived_at IS NULL", [viewer.id, input.fallbackForSourceId])).rows[0];
    requireCondition(source, "not_found", "That source is not available for a screenshot fallback.", 404);
  }
  const normalized = await normalizeMaterial(input.bytes);
  if (input.commandKey) {
    const existing = (await pool.query<{ id: string; role: BrandMaterial["role"]; label: string; fallback_for: string | null; content_hash: string | null }>("SELECT s.id,s.role,s.label,s.fallback_for,m.content_hash FROM brand_source s LEFT JOIN brand_material m ON m.owner_id=s.owner_id AND m.source_id=s.id AND m.kind='image' WHERE s.owner_id=$1 AND s.command_key=$2", [viewer.id, input.commandKey])).rows[0];
    if (existing) {
      requireCondition(existing.role === input.role && existing.label === input.label && existing.fallback_for === (input.fallbackForSourceId ?? null) && existing.content_hash === normalized.hash, "idempotency_conflict", "This upload command was already used for another material.", 409);
      return readBrand(viewer.id);
    }
  }
  let stored: string | undefined;
  let commitPossible = false;
  try {
    return await transaction(async (client) => {
      const brand = await lockBrand(client, viewer); assertBrandVersion(brand.version, input.version);
      if (input.fallbackForSourceId) requireCondition((await client.query("SELECT id FROM brand_source WHERE owner_id=$1 AND id=$2 AND kind IN ('website','social') AND archived_at IS NULL", [viewer.id, input.fallbackForSourceId])).rowCount, "not_found", "That source is not available for a screenshot fallback.", 404);
      await checkMaterialQuota(client, viewer.id, normalized.bytes, true);
      stored = await storeMaterial(normalized.data);
      const sourceId = randomUUID();
      await client.query("INSERT INTO brand_source(id,owner_id,kind,role,label,acquisition_state,outcome_code,fallback_for,resulting_brand_version,acquired_at,command_key) VALUES($1,$2,'upload',$3,$4,'available','upload_normalized',$5,$6,now(),$7)", [sourceId, viewer.id, input.role, input.label, input.fallbackForSourceId ?? null, brand.version + 1, input.commandKey ?? null]);
      await client.query("INSERT INTO brand_material(id,owner_id,role,kind,label,stored_name,mime,bytes,width,height,content_hash,source_id) VALUES($1,$2,$3,'image',$4,$5,'image/png',$6,$7,$8,$9,$10)", [randomUUID(), viewer.id, input.role, input.label, stored, normalized.bytes, normalized.width, normalized.height, normalized.hash, sourceId]);
      await client.query("UPDATE brand_workspace SET version=version+1,updated_at=now() WHERE owner_id=$1", [viewer.id]);
      const result = await readBrand(viewer.id, client);
      commitPossible = true;
      return result;
    });
  } catch (error) { if (stored && !commitPossible) await discardMaterial(stored); throw error; }
}

export async function archiveBrandMaterial(viewer: Viewer, id: string, version: number) {
  return transaction(async (client) => {
    const brand = await lockBrand(client, viewer); assertBrandVersion(brand.version, version);
    const changed = await client.query("UPDATE brand_material SET archived_at=now() WHERE owner_id=$1 AND id=$2 AND archived_at IS NULL RETURNING id", [viewer.id, id]);
    requireCondition(changed.rowCount, "not_found", "That active material is not available.", 404);
    await client.query("UPDATE brand_workspace SET version=version+1,updated_at=now() WHERE owner_id=$1", [viewer.id]);
    return readBrand(viewer.id, client);
  });
}

export async function readBrandMaterial(ownerId: string, id: string, client: Client = pool) {
  const row = (await client.query<MaterialRow>("SELECT * FROM brand_material WHERE owner_id=$1 AND id=$2 AND kind='image'", [ownerId, id])).rows[0];
  requireCondition(row?.stored_name && row.content_hash, "not_found", "That private image is not available.", 404);
  return { view: materialView(row), bytes: await materialBytes(row.stored_name, row.content_hash) };
}

export async function freezeBrand(ownerId: string, state: PublicationView, client: Client = pool): Promise<FrozenBrand> {
  const brand = await readBrand(ownerId, client);
  const brief: PublicationBrief = state.brandBrief ?? { audience: brand.rules.audience, direction: brand.rules.palette, requiredMaterialIds: [], noPhoto: false, blockingFacts: [], factResolution: "" };
  const standingDirection = brand.rules.artDirection ?? defaultArtDirection(brand.rules.palette);
  const art = state.designPolicy ? state.artDirection ?? freezeArtDirection(brief.noPhoto ? withoutHeroImages(standingDirection) : standingDirection, brand.materials, brief.noPhoto) : undefined;
  const value = { version: brand.version, rules: brand.rules, materials: brand.materials, brief, rendererPolicy: art ? "art-direction-v1" as const : "brand-palette-v1" as const, ...(art ? { art } : {}) };
  return { ...value, hash: inputHash(value) };
}

export async function verifyFrozenBrand(ownerId: string, brand: FrozenBrand, client: Client = pool) {
  const { hash, ...value } = brand;
  requireCondition(inputHash(value) === hash, "brand_snapshot_invalid", "The saved brand snapshot is invalid.", 409);
  if (brand.rendererPolicy === "art-direction-v1") {
    requireCondition(brand.art && canonicalJson(freezeArtDirection(brand.art.direction, brand.materials, brand.brief.noPhoto)) === canonicalJson(brand.art), "brand_snapshot_invalid", "The accepted original image selection is invalid.", 409);
  }
  for (const material of brand.materials) {
    const row = (await client.query<MaterialRow>("SELECT * FROM brand_material WHERE owner_id=$1 AND id=$2", [ownerId, material.id])).rows[0];
    requireCondition(row && row.version === material.version && row.content_hash === material.contentHash, "material_unavailable", "A saved material version could not be verified.", 409);
    if (row.kind === "image") await materialBytes(row.stored_name!, row.content_hash!);
  }
}

export async function assertCurrentBrand(ownerId: string, version: number, client: Client) { assertBrandVersion((await readBrand(ownerId, client)).version, version); }
