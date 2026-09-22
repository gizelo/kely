import { createHash, randomUUID } from "node:crypto";
import type { BudgetPackageInput } from "./budget/store";
import type { BrandEvidenceRecord, BrandIntelligenceSnapshot, BrandResearchInput, EntityCandidate } from "../shared/brand-intelligence";
import type { ResearchRunView, ResearchStatus, SourceOutcome } from "./brand-intelligence-store";
import { assembleResearchContext } from "./brand-intelligence-context";
import { canonicalEvidenceUrl, classifyResearchReadiness, createBrandIntelligenceSnapshot, evidenceRecordFromSpan } from "./brand-intelligence";
import { acquireResearchSources, type ResearchAcquisitionResult, type ResearchSourceSeed } from "./research-source-acquisition";
import type { EntitySearchInput, EntitySearchResult } from "./providers/research-dispatcher";
import { checkStageAttempt, extractionStageAttempt, parseCheckStageResponse, parseExtractionStageResponse, parseStrategyDraftStageResponse, strategyStageAttempt } from "./providers/research-stages";
import { analysisRequest, parseAnalysis, type AnalysisInput } from "./providers/analysis";
import { bindResearchAttempt } from "./budget/research-package";
import { inputHash } from "./paid-input";
import type { AnalysisProposal } from "../shared/analysis";

interface DurableStore {
  read(ownerId: string, runId: string): Promise<ResearchRunView>;
  appendStatus(ownerId: string, runId: string, status: ResearchStatus, detail?: unknown): Promise<ResearchRunView>;
  addSource(ownerId: string, runId: string, evidence: EntitySearchResult["evidence"][number], outcome: SourceOutcome): Promise<ResearchRunView>;
  acceptSnapshot(ownerId: string, runId: string, snapshot: BrandIntelligenceSnapshot): Promise<{ id: string; version: number; hash: string }>;
}
type Gateway = { dispatch(input: any): Promise<{ response: unknown; assessment: unknown; replayed: boolean }> };

export interface LiveResearchDependencies {
  store: DurableStore;
  verifyReservation(reservation: BudgetPackageInput): Promise<void>;
  search(input: EntitySearchInput): Promise<EntitySearchResult>;
  gateway: Gateway;
  materialInput?: AnalysisInput | null;
  persistMaterialAnalysis?(proposal: AnalysisProposal, requestHash: string): Promise<void>;
  acquire?(seeds: ResearchSourceSeed[], fetchedAt: string): Promise<ResearchAcquisitionResult>;
  closeFromDurableEvidence(run: ResearchRunView): Promise<void>;
  resolvedAssetKeys?: string[];
}

function exactReservation(value: BudgetPackageInput, ownerId: string, runId: string) {
  const required = ["entity-search-1", "entity-search-2", "extract:0", "strategy:0", "check:0"];
  if (value.ownerId !== ownerId || value.operationId !== runId || required.some((step) => !value.steps.some((item) => item.step === step && item.maximumMicros > 0))) throw new Error("research_package_reservation_invalid");
}

function stageContext(value: unknown) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") > 60 * 1024) throw new Error("research_stage_context_too_large");
  return text;
}

function normalizedEntityName(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("en").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function suppliedHostNameMatches(requestedName: string, candidateName: string) {
  const requested = normalizedEntityName(requestedName);
  const candidate = normalizedEntityName(candidateName);
  return requested.length > 0 && (candidate === requested || candidate.startsWith(`${requested} `));
}

export function materialObservationEvidence(runId: string, materialId: string, content: string, fetchedAt: string) {
  const records: BrandEvidenceRecord[] = [];
  for (let start = 0, index = 0; start < content.length; index += 1) {
    let end = start; let characters = 0;
    while (end < content.length && characters < 500) {
      const point = content.codePointAt(end)!;
      const width = point > 0xFFFF ? 2 : 1;
      if (end - start + width > 500) break;
      end += width;
      characters += 1;
    }
    const bytes = createHash("sha256").update(`${runId}:material:${materialId}:${index}`, "utf8").digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 0x0F) | 0x50; bytes[8] = (bytes[8] & 0x3F) | 0x80;
    const hex = bytes.toString("hex");
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    records.push(evidenceRecordFromSpan({ id, sourceKind: "upload", sourceRole: "user_provided", sourceUrl: `https://kely.invalid/material/${materialId}`, content, span: { start, end }, fetchedAt }));
    start = end;
  }
  return records;
}

export function materialObservationContext(observations: AnalysisProposal["observations"], evidence: BrandEvidenceRecord[]) {
  return observations.map((observation) => ({ ...observation, evidenceIds: evidence.filter((item) => item.sourceUrl.endsWith(`/material/${observation.materialId}`)).map((item) => item.id) }));
}

export async function runLiveResearch(ownerId: string, runId: string, input: BrandResearchInput, reservation: BudgetPackageInput, dependencies: LiveResearchDependencies) {
  exactReservation(reservation, ownerId, runId); await dependencies.verifyReservation(reservation);
  const current = await dependencies.store.read(ownerId, runId);
  if (current.status !== "queued") return current;
  const initialEvidence = current.sources.map(({ outcome: _outcome, ...item }) => item);
  await dependencies.store.appendStatus(ownerId, runId, "resolving", { packageId: reservation.id });
  try {
    let materialAnalysis: AnalysisProposal | null = null;
    const materialEvidence: EntitySearchResult["evidence"] = [];
    if (dependencies.materialInput) {
      if (!reservation.steps.some((item) => item.step === "materials:0" && item.maximumMicros === 532_373)) throw new Error("research_material_reservation_invalid");
      if (!dependencies.persistMaterialAnalysis) throw new Error("research_material_persistence_unavailable");
      const request = analysisRequest(dependencies.materialInput, "brand-analysis-v2");
      const reply = await dependencies.gateway.dispatch(bindResearchAttempt({ key: `kely:${runId}:materials:0`, ownerId, operationId: runId, step: "materials:0", snapshot: { acceptedHash: inputHash(dependencies.materialInput), input: dependencies.materialInput }, request }, reservation));
      materialAnalysis = parseAnalysis(reply.response, dependencies.materialInput, "brand-analysis-v2");
      await dependencies.persistMaterialAnalysis(materialAnalysis, inputHash(request));
      const fetchedAt = new Date().toISOString();
      for (const observation of materialAnalysis.observations) {
        for (const evidence of materialObservationEvidence(runId, observation.materialId, observation.evidence, fetchedAt)) {
          materialEvidence.push(evidence);
          await dependencies.store.addSource(ownerId, runId, evidence, "complete");
        }
      }
    } else if (reservation.steps.some((item) => item.step === "materials:0")) throw new Error("research_material_reservation_unexpected");
    const first = await dependencies.search({ ownerId, runId, businessName: input.businessName, category: input.category, location: input.location, userSuppliedUrls: input.userSuppliedUrls, searchNumber: 1, fetchedAt: new Date().toISOString(), reservation });
    const candidates = [...first.candidates]; const discoveredEvidence = [...first.evidence];
    if (!candidates.length) {
      const second = await dependencies.search({ ownerId, runId, businessName: input.businessName, category: input.category, location: input.location, userSuppliedUrls: input.userSuppliedUrls, searchNumber: 2, fetchedAt: new Date().toISOString(), reservation });
      candidates.push(...second.candidates); discoveredEvidence.push(...second.evidence);
    }
    for (const evidence of discoveredEvidence) await dependencies.store.addSource(ownerId, runId, evidence, "complete");
    await dependencies.store.appendStatus(ownerId, runId, "fetching", { candidates: candidates.length });
    const seeds: ResearchSourceSeed[] = [...input.userSuppliedUrls.map((url) => ({ url, role: "official" as const, kind: "website" as const })), ...candidates.map((candidate) => ({ url: candidate.canonicalUrl, role: "external_context" as const, kind: "website" as const, candidateId: candidate.id, expectedName: input.businessName }))];
    const acquired = await (dependencies.acquire ?? ((values, fetchedAt) => acquireResearchSources(values, fetchedAt, {}, runId)))(seeds, new Date().toISOString());
    const proven = acquired.outcomes.filter((item) => item.status === "complete" && item.candidateId && item.identity?.exactNameMatch && item.identity.canonicalSameHost && item.identity.linkedSocialProfile);
    const sameNameCandidates = candidates.filter((candidate) => normalizedEntityName(candidate.displayName) === normalizedEntityName(input.businessName));
    const selectedCandidateId = proven.length === 1 && sameNameCandidates.length === 1 ? proven[0].candidateId : null;
    const selectedHost = selectedCandidateId ? new URL(candidates.find((item) => item.id === selectedCandidateId)!.canonicalUrl).hostname : null;
    const selectedEvidence = selectedHost ? acquired.evidence.filter((item) => new URL(item.sourceUrl).hostname === selectedHost).map((item) => {
      return { ...item, id: randomUUID(), sourceRole: "official" as const };
    }) : [];
    const userOfficialHosts = new Set(input.userSuppliedUrls.map((url) => new URL(canonicalEvidenceUrl(url)).hostname));
    const userOfficialEvidence = acquired.evidence.filter((item) => item.sourceRole === "official" && userOfficialHosts.has(new URL(item.sourceUrl).hostname));
    const ids = new Set([...initialEvidence, ...discoveredEvidence].map((item) => item.id)); const acquiredEvidence = [...userOfficialEvidence, ...selectedEvidence].filter((item) => !ids.has(item.id));
    for (const evidence of acquiredEvidence) await dependencies.store.addSource(ownerId, runId, evidence, "complete");
    const evidence = [...initialEvidence, ...materialEvidence, ...discoveredEvidence, ...acquiredEvidence];
    await dependencies.store.appendStatus(ownerId, runId, "extracting", { evidence: evidence.length });
    const context = stageContext({ research: assembleResearchContext(input, evidence), materialObservations: materialAnalysis ? materialObservationContext(materialAnalysis.observations, materialEvidence) : [], materialDirection: materialAnalysis?.direction ?? null, materialLimitations: materialAnalysis?.limitations ?? [] });
    const extractionRaw = await dependencies.gateway.dispatch(extractionStageAttempt({ ownerId, runId, context, reservation }));
    const extraction = parseExtractionStageResponse(extractionRaw.response, evidence);
    const suppliedHosts = new Set(input.userSuppliedUrls.map((url) => new URL(canonicalEvidenceUrl(url)).hostname));
    const candidatePool = candidates.length > 0 ? candidates : input.userSuppliedUrls.map((url, index) => ({
      id: `supplied-${index + 1}`,
      displayName: input.businessName,
      canonicalUrl: canonicalEvidenceUrl(url),
      evidenceIds: [],
      signals: { userSuppliedUrl: true, officialSiteClaim: false, exactNameMatch: true, crossLinkedProfile: false },
    }));
    const entityCandidates: EntityCandidate[] = candidatePool.map((candidate) => {
      const hostname = new URL(candidate.canonicalUrl).hostname;
      const officialIds = evidence.filter((item) => item.sourceRole === "official" && new URL(item.sourceUrl).hostname === hostname).map((item) => item.id);
      const localProof = candidate.id === selectedCandidateId;
      const suppliedNameProof = suppliedHosts.has(hostname) && suppliedHostNameMatches(input.businessName, candidate.displayName);
      return { ...candidate, evidenceIds: [...new Set([...candidate.evidenceIds, ...officialIds])], signals: { ...candidate.signals, exactNameMatch: localProof || suppliedNameProof || candidate.signals.exactNameMatch, crossLinkedProfile: localProof, officialSiteClaim: (suppliedHosts.has(hostname) || localProof) && officialIds.length > 0 } };
    });
    const base = createBrandIntelligenceSnapshot({ id: randomUUID(), version: 1, createdAt: new Date().toISOString(), query: { businessName: input.businessName, userSuppliedUrls: input.userSuppliedUrls }, evidence, entityCandidates, claims: extraction.claims, requiredAssets: extraction.requiredAssets });
    const readiness = classifyResearchReadiness(base, [], dependencies.resolvedAssetKeys);
    if (!readiness.ready) {
      await dependencies.store.acceptSnapshot(ownerId, runId, base);
      const result = await dependencies.store.appendStatus(ownerId, runId, "needs_input", { questions: readiness.questions.slice(0, 3), packageId: reservation.id });
      await dependencies.closeFromDurableEvidence(result); return result;
    }
    await dependencies.store.appendStatus(ownerId, runId, "strategizing", { packageId: reservation.id });
    const strategyRaw = await dependencies.gateway.dispatch(strategyStageAttempt({ ownerId, runId, context: stageContext({ input, snapshot: base }), reservation }));
    const strategy = parseStrategyDraftStageResponse(strategyRaw.response);
    await dependencies.store.appendStatus(ownerId, runId, "checking", { packageId: reservation.id });
    const checkRaw = await dependencies.gateway.dispatch(checkStageAttempt({ ownerId, runId, context: stageContext({ input, snapshot: base, strategy }), reservation }));
    const check = parseCheckStageResponse(checkRaw.response, strategy, extraction.claims, evidence, input);
    const finalSnapshot = { ...base, strategy: check.result, critic: { outcome: check.outcome, issues: check.issues } } as BrandIntelligenceSnapshot;
    await dependencies.store.acceptSnapshot(ownerId, runId, finalSnapshot);
    const result = await dependencies.store.appendStatus(ownerId, runId, "review_ready", { packageId: reservation.id, criticOutcome: check.outcome });
    await dependencies.closeFromDurableEvidence(result); return result;
  } catch (error) {
    const uncertain = (error as { code?: unknown })?.code === "attempt_uncertain";
    const result = await dependencies.store.appendStatus(ownerId, runId, uncertain ? "uncertain" : "failed", { reason: uncertain ? "provider_outcome_unknown" : "research_pipeline_failed", packageId: reservation.id });
    if (!uncertain) await dependencies.closeFromDurableEvidence(result);
    return result;
  }
}
