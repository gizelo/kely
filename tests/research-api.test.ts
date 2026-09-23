import assert from "node:assert/strict";
import test from "node:test";
import type { BrandEvidenceRecord, BrandIntelligenceSnapshot } from "../src/shared/brand-intelligence";
import type { ResearchRunView, ResearchStatus } from "../src/server/brand-intelligence-store";
import { ResearchService, researchCorrectionSchema, researchStartSchema } from "../src/server/research-service";

const viewer = { id: "owner-1", name: "Owner", email: "owner@example.test" };

class FakeStore {
  runs = new Map<string, ResearchRunView>();
  keys = new Map<string, string>();
  starts: { ownerId: string; supersedes: string | null }[] = [];
  async list(ownerId: string, limit = 20) { return [...this.runs.values()].filter((run) => run.ownerId === ownerId).reverse().slice(0, limit); }
  async start(ownerId: string, input: unknown, commandKey: string, supersedes: string | null = null) {
    const priorId = this.keys.get(`${ownerId}:${commandKey}`);
    if (priorId) return this.read(ownerId, priorId);
    const id = `00000000-0000-4000-8000-${String(this.runs.size + 1).padStart(12, "0")}`;
    const run: ResearchRunView = { id, ownerId, commandKey, inputHash: "a".repeat(64), input, supersedesRunId: supersedes, status: "queued", statusDetail: {}, createdAt: new Date().toISOString(), sources: [], snapshots: [] };
    this.runs.set(id, run); this.keys.set(`${ownerId}:${commandKey}`, id); this.starts.push({ ownerId, supersedes }); return run;
  }
  async read(ownerId: string, id: string) { const run = this.runs.get(id); if (!run || run.ownerId !== ownerId) throw Object.assign(new Error("not found"), { code: "research_not_found" }); return run; }
  async appendStatus(ownerId: string, id: string, status: ResearchStatus, detail: unknown = {}) { const run = await this.read(ownerId, id); run.status = status; run.statusDetail = detail; return run; }
  async addSource(ownerId: string, id: string, evidence: BrandEvidenceRecord, outcome: "complete") { const run = await this.read(ownerId, id); run.sources.push({ ...evidence, outcome }); return run; }
  async acceptSnapshot(ownerId: string, id: string, snapshot: BrandIntelligenceSnapshot) { const run = await this.read(ownerId, id); const saved = { ...snapshot, id: `10000000-0000-4000-8000-${String(run.snapshots.length + 1).padStart(12, "0")}`, version: run.snapshots.length + 1 }; run.snapshots.push({ id: saved.id, version: saved.version, hash: "b".repeat(64), value: saved, supersedesSnapshotId: null, acceptedAt: new Date().toISOString() }); return { id: saved.id, version: saved.version, hash: "b".repeat(64) }; }
}

function valid(commandKey = "research-command-1") { return { businessName: "Girex", idea: "Introduce the product", platform: "linkedin", userSuppliedUrls: ["https://girex.io"], materialIds: [], commandKey }; }

test("research input is strict, bounded and HTTPS-only", () => {
  assert.equal(researchStartSchema.parse(valid()).businessName, "Girex");
  assert.throws(() => researchStartSchema.parse({ ...valid(), extra: true }));
  assert.throws(() => researchStartSchema.parse({ ...valid(), userSuppliedUrls: ["http://girex.io"] }));
  assert.throws(() => researchCorrectionSchema.parse({ commandKey: "correct-command" }));
  assert.throws(() => researchStartSchema.parse({ ...valid(), idea: "Create a one-slide carousel" }), /at least two slides/u);
  assert.throws(() => researchCorrectionSchema.parse({ commandKey: "correct-command", idea: "Create a single post with 3 slides" }), /only one slide/u);
});

test("a contradictory brief is rejected before entitlement, storage or dispatch", async () => {
  const previous = process.env.KELY_RESEARCH_MODE; process.env.KELY_RESEARCH_MODE = "openai";
  try {
    const store = new FakeStore(); let entitlements = 0; let dispatches = 0;
    const service = new ResearchService(store, async () => { entitlements += 1; }, async (_viewer, run) => { dispatches += 1; return run; });
    await assert.rejects(service.start(viewer, { ...valid("conflicting-command"), idea: "Create a one-slide carousel" }), /at least two slides/u);
    assert.equal(entitlements, 0);
    assert.equal(store.starts.length, 0);
    assert.equal(dispatches, 0);
  } finally { if (previous === undefined) delete process.env.KELY_RESEARCH_MODE; else process.env.KELY_RESEARCH_MODE = previous; }
});

test("fixture start is entitlement-gated, idempotent and explicitly simulated", async () => {
  process.env.KELY_RESEARCH_MODE = "fixture";
  const store = new FakeStore(); let checks = 0;
  const service = new ResearchService(store, async () => { checks += 1; });
  const first = await service.start(viewer, valid());
  const replay = await service.start(viewer, valid());
  assert.equal(checks, 2);
  assert.equal(first.id, replay.id);
  assert.equal(first.status, "needs_input");
  assert.equal(first.simulated, true);
  assert.ok("notice" in first); assert.match(first.notice, /does not search the web/u);
  assert.equal(first.sources[0].sourceRole, "user_provided");
});

test("answers and corrections create owner-scoped superseding runs", async () => {
  process.env.KELY_RESEARCH_MODE = "fixture";
  const store = new FakeStore(); const service = new ResearchService(store, async () => {});
  const parent = await service.start(viewer, valid("parent-command"));
  const answered = await service.answer(viewer, parent.id, { commandKey: "answer-command", answers: [{ code: "entity_conflict", key: "business_identity", value: "This is the business at girex.io" }] });
  const corrected = await service.correct(viewer, answered.id, { commandKey: "correct-command", location: "Tbilisi" });
  assert.equal(answered.supersedesRunId, parent.id);
  assert.equal(corrected.supersedesRunId, answered.id);
  await assert.rejects(service.read("another-owner", parent.id), { code: "research_not_found" });
});

test("research history is owner-scoped and omits internal keys and source payloads", async () => {
  process.env.KELY_RESEARCH_MODE = "fixture";
  const store = new FakeStore(); const service = new ResearchService(store, async () => {});
  const first = await service.start(viewer, valid("history-command-1"));
  await service.start(viewer, valid("history-command-2"));
  await store.start("another-owner", { type: "start", researchMode: "fixture", research: valid(), materialIds: [] }, "other-history-command");
  const history = await service.list(viewer.id);
  assert.equal(history.length, 2);
  assert.equal(history.at(-1)?.id, first.id);
  assert.equal("commandKey" in history[0], false);
  assert.equal("inputHash" in history[0], false);
  assert.equal("sources" in history[0], false);
});

test("openai research mode fails closed without a dispatcher", async () => {
  const previous = process.env.KELY_RESEARCH_MODE; process.env.KELY_RESEARCH_MODE = "openai";
  try {
    const store = new FakeStore(); const service = new ResearchService(store, async () => {}, null);
    process.env.KELY_RESEARCH_MODE = "fixture"; const saved = await service.start(viewer, valid()); process.env.KELY_RESEARCH_MODE = "openai";
    await assert.rejects(service.start(viewer, valid("another-command")), { code: "research_dispatch_unavailable" });
    assert.equal((await service.read(viewer.id, saved.id)).id, saved.id);
  }
  finally { if (previous === undefined) delete process.env.KELY_RESEARCH_MODE; else process.env.KELY_RESEARCH_MODE = previous; }
});

test("stored mode is reported honestly and accepts at most three material ids", async () => {
  const previous = process.env.KELY_RESEARCH_MODE; process.env.KELY_RESEARCH_MODE = "openai";
  try {
    const store = new FakeStore();
    const service = new ResearchService(store, async () => {}, async (_viewer, run) => run);
    const created = await service.start(viewer, valid("live-mode-command"));
    assert.equal(created.researchMode, "openai");
    assert.equal(created.simulated, false);
    const read = await service.read(viewer.id, created.id);
    assert.equal(read.researchMode, "openai");
    const withMaterial = await service.start(viewer, { ...valid("material-command"), materialIds: ["00000000-0000-4000-8000-000000000001"] });
    assert.equal(withMaterial.researchMode, "openai");
    assert.throws(() => researchStartSchema.parse({ ...valid("too-many-materials"), materialIds: Array.from({ length: 4 }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`) }));
  } finally { if (previous === undefined) delete process.env.KELY_RESEARCH_MODE; else process.env.KELY_RESEARCH_MODE = previous; }
});

test("cloud live research is enqueued and returns its durable queued run immediately", async () => {
  const previous = process.env.KELY_RESEARCH_MODE; process.env.KELY_RESEARCH_MODE = "openai";
  try {
    const store = new FakeStore(); const queued: string[] = []; let executed = 0;
    const service = new ResearchService(store, async () => {}, async (_viewer, run) => { executed += 1; return run; }, async (_ownerId, runId) => { queued.push(runId); });
    const created = await service.start(viewer, valid("queued-live-command"));
    assert.equal(created.status, "queued");
    assert.deepEqual(queued, [created.id]);
    assert.equal(executed, 0);
  } finally { if (previous === undefined) delete process.env.KELY_RESEARCH_MODE; else process.env.KELY_RESEARCH_MODE = previous; }
});
