"use client";

import Image from "next/image";
import {
  ArrowRight,
  Check,
  ImagePlus,
  Link2,
  Palette,
  Send,
  Type,
  Undo2,
  Upload,
  Archive,
  Sparkles,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type {
  BrandEvent,
  BrandField,
  BrandImportOutcome,
  BrandImportResult,
  BrandMaterial,
  BrandPalette,
  BrandView,
  BrandValue,
  MemoryInterpretation,
  SourceBundleView,
  SourceStrategy,
  BrandSource,
} from "../shared/brand";
import { displayDate, request, uploadRaster } from "./api";
import { useBrandData, type RunBrandAction } from "./brand-data";
import { ArtDirectionEditor } from "./art-direction-editor";
import { BrandAnalysis } from "./brand-analysis";

export const paletteOptions: {
  value: BrandPalette;
  label: string;
  description: string;
}[] = [
  {
    value: "indigo",
    label: "Indigo",
    description: "Soft violet, thoughtful contrast",
  },
  {
    value: "forest",
    label: "Forest",
    description: "Calm green, natural warmth",
  },
  { value: "rose", label: "Rose", description: "Warm blush, a softer voice" },
  { value: "sand", label: "Sand", description: "Quiet neutrals, warm detail" },
];

export function BrandCapabilities({ compact = false }: { compact?: boolean }) {
  return (
    <details className="brand-capability-details">
      <summary>How your brand is used</summary>
      <div className={"brand-capabilities" + (compact ? " compact" : "")}>
        <span>
          <Check size={14} />
          <strong>Visual direction</strong> Saved for newly prepared posts
        </span>
        <span>
          <ImagePlus size={14} />
          <strong>Chosen originals</strong> Composed in new brand-aware posts
        </span>
        <span>
          <Type size={14} />
          <strong>Shorter headlines</strong> Used in new brand-aware preparation
        </span>
      </div>
      <p className="brand-helper">
        New posts use your saved direction and originals. Earlier posts stay unchanged.
      </p>
    </details>
  );
}

export function BrandMemory({
  busy,
  onRemember,
  onLocal,
}: {
  busy: boolean;
  onRemember: (text: string) => Promise<MemoryInterpretation | null>;
  onLocal?: () => void;
}) {
  const [text, setText] = useState("");
  const [exchanges, setExchanges] = useState<
    { text: string; reply: MemoryInterpretation }[]
  >([]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim() || busy) return;
    const savedText = text.trim();
    const reply = await onRemember(savedText);
    if (!reply) return;
    setExchanges((items) => [...items, { text: savedText, reply }]);
    if (reply.status === "durable") setText("");
  }
  return (
    <section className="brand-memory" aria-labelledby="brand-memory-title">
      <div className="brand-section-heading">
        <div>
          <h2 id="brand-memory-title">Teach Kely something.</h2>
          <p>Say what should stay consistent in future posts.</p>
        </div>
      </div>
      <div
        className="brand-memory-log"
        role="log"
        aria-live="polite"
        aria-label="Brand preference conversation"
      >
        {exchanges.map((item, index) => (
          <div className="brand-exchange" key={index}>
            <p className="brand-user-message" dir="auto">
              {item.text}
            </p>
            <div className="brand-memory-reply">
              <span
                className={
                  "brand-label " +
                  (item.reply.status === "durable" ? "brand-label-applied" : "")
                }
              >
                {item.reply.status === "durable"
                  ? "Saved to Brand"
                  : item.reply.status === "local"
                    ? "Post-only · not applied here"
                    : "Clarification · nothing saved"}
              </span>
              <p>{item.reply.effect}</p>
              {item.reply.status === "durable" && (
                <small>You can undo this update in preference history.</small>
              )}
              {item.reply.status === "local" && (
                <>
                  {onLocal ? (
                    <button
                      type="button"
                      className="text-button"
                      disabled={busy}
                      onClick={onLocal}
                    >
                      Set no photo in this draft’s brief
                      <ArrowRight size={14} />
                    </button>
                  ) : (
                    <small>
                      Open an unapproved post and choose “No photo in this post”
                      in its brief. Nothing has been applied to a post yet.
                    </small>
                  )}
                </>
              )}
            </div>
          </div>
        ))}
      </div>
      <form className="brand-memory-form" onSubmit={submit}>
        <label htmlFor="brand-memory-request">
          What should stay consistent?
        </label>
        <textarea
          id="brand-memory-request"
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={3}
          maxLength={1000}
          placeholder="Always use shorter headlines for our brand."
          disabled={busy}
        />
        <div className="brand-memory-prompts">
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              setText("Always use shorter headlines for our brand")
            }
          >
            Shorter headlines
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setText("Always use forest palette")}
          >
            Forest palette
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setText("No photo in this post")}
          >
            Only this post
          </button>
        </div>
        <button className="button primary" disabled={busy || !text.trim()}>
          Save or clarify preference
          <Send size={15} />
        </button>
      </form>
    </section>
  );
}

function fieldValue(field: BrandField, value: BrandValue) {
  if (value === null || value === "") return "Not set";
  if (typeof value === "object") return "Visual direction";
  if (field === "headlines")
    return value === "shorter" ? "Shorter headlines" : "Default headlines";
  if (field === "sourceStrategy")
    return strategyLabels[value as SourceStrategy] ?? "Creative starting point";
  return value;
}
function fieldLabel(field: BrandField) {
  return field === "artDirection"
    ? "visual direction"
    : field === "sourceStrategy"
      ? "creative starting point"
      : field;
}

const strategyLabels: Record<SourceStrategy, string> = {
  use_materials: "Add what I have",
  use_preferences: "Describe the style",
  decide_for_me: "Decide for me",
};

export function BrandHistory({
  brand,
  busy,
  onUndo,
}: {
  brand: BrandView;
  busy: boolean;
  onUndo: (eventId: string) => void;
}) {
  const events = [...brand.events].sort((a, b) => b.version - a.version);
  return (
    <section className="brand-history">
      <h2>Preference history</h2>
      <p className="brand-helper">
        Undo changes one preference. Newer changes to other fields stay intact.
      </p>
      {events.length ? (
        <ol>
          {events.map((event: BrandEvent) => {
            const undone = events.some((item) => item.undoOf === event.id);
            const superseded = events.some(
              (item) =>
                item.field === event.field && item.version > event.version,
            );
            return (
              <li key={event.id}>
                <div>
                  <span className="brand-label">
                    User-provided · v{event.version}
                  </span>
                  <strong>
                    {event.undoOf ? "Undid " : "Updated "}
                    {fieldLabel(event.field)}
                  </strong>
                  <p dir="auto">
                    {fieldValue(event.field, event.before)} →{" "}
                    {fieldValue(event.field, event.after)}
                  </p>
                  <time dateTime={event.createdAt}>
                    {displayDate(event.createdAt)}
                  </time>
                </div>
                {event.undoOf ? (
                  <span className="brand-history-state">Undo recorded</span>
                ) : undone ? (
                  <span className="brand-history-state">Undone</span>
                ) : superseded ? (
                  <span className="brand-history-state">
                    Newer {fieldLabel(event.field)} update
                  </span>
                ) : (
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => onUndo(event.id)}
                    aria-label={`Undo ${fieldLabel(event.field)} update from version ${event.version}`}
                  >
                    <Undo2 size={14} />
                    Undo
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="brand-empty-note">
          Your confirmed preferences will appear here. Nothing is learned
          silently from a generated post.
        </p>
      )}
    </section>
  );
}

export function BrandWorkspace({
  businessFacts,
  busy,
  canEdit,
  run,
  onError,
  onBilling,
  availableCredits,
  onAccountRefresh,
  onContinue,
}: {
  businessFacts: ReactNode;
  busy: boolean;
  canEdit: boolean;
  run: RunBrandAction;
  onError: (error: unknown) => void;
  onBilling: () => void;
  availableCredits: number;
  onAccountRefresh: () => Promise<unknown>;
  onContinue: () => void;
}) {
  const data = useBrandData(onError, run);
  const [bundle, setBundle] = useState<SourceBundleView | null>(null);
  const [bundleError, setBundleError] = useState("");
  const [bundleRevision, setBundleRevision] = useState(0);
  const [intake, setIntake] = useState<"materials" | "preferences" | null>(
    null,
  );
  const [fallbackId, setFallbackId] = useState<string | null>(null);
  const [analysisRequest, setAnalysisRequest] = useState<{
    id: string | null;
    sequence: number;
  }>();
  const uploadKeys = useRef(new WeakMap<File, string>());
  const intakeElement = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!intake) return;
    const frame = requestAnimationFrame(() =>
      intakeElement.current
        ?.querySelector<HTMLElement>("input, textarea, select")
        ?.focus(),
    );
    return () => cancelAnimationFrame(frame);
  }, [intake, fallbackId]);
  function closeIntake() {
    setIntake(null);
    requestAnimationFrame(() =>
      document.getElementById("brand-overview-title")?.focus(),
    );
  }
  const refreshBundle = useCallback(async () => {
    setBundleRevision((current) => current + 1);
  }, []);
  const brandVersion = data.brand?.version;
  useEffect(() => {
    if (brandVersion === undefined) return;
    const controller = new AbortController();
    setBundleError("");
    void request<SourceBundleView>(
      "/api/kely/brand/source-bundle",
      undefined,
      controller.signal,
    )
      .then((next) => {
        if (!controller.signal.aborted) setBundle(next);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setBundleError(
          "Your source summary could not be refreshed. Saved materials and posts are unchanged.",
        );
        onError(error);
      });
    return () => controller.abort();
  }, [brandVersion, bundleRevision, onError]);
  const currentBundle =
    bundle?.brandVersion === brandVersion && !bundleError ? bundle : null;
  type BrandSection = "overview" | "style" | "materials" | "analysis";
  const [section, setSection] = useState<BrandSection>("overview");
  const [analysisOpened, setAnalysisOpened] = useState(false);
  const brandSections = ["overview", "style", "materials"] as const;
  function selectSection(next: BrandSection) {
    setSection(next);
    if (next === "analysis") setAnalysisOpened(true);
  }
  function moveSection(
    event: KeyboardEvent<HTMLButtonElement>,
    current: (typeof brandSections)[number],
  ) {
    const offset =
      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const target =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? brandSections.length - 1
          : offset
            ? (brandSections.indexOf(current) + offset + brandSections.length) %
              brandSections.length
            : -1;
    if (target < 0) return;
    event.preventDefault();
    selectSection(brandSections[target]);
    requestAnimationFrame(() =>
      document.getElementById(`brand-tab-${brandSections[target]}`)?.focus(),
    );
  }
  const locked = busy || !canEdit;
  async function rule(field: BrandField, value: string | null) {
    if (!data.brand) return;
    const input = { field, value, version: data.brand.version };
    return data.change(() =>
      request<BrandView>("/api/kely/brand/rules", {
        ...input,
        commandKey: data.commandKey("rules", input),
      }),
    );
  }
  async function chooseStrategy(strategy: SourceStrategy) {
    if (!data.brand || locked) return;
    const input = { strategy, version: data.brand.version };
    const saved = await data.change(async () => {
      const next = await request<SourceBundleView>(
        "/api/kely/brand/source-strategy",
        {
          ...input,
          commandKey: data.commandKey("source-strategy", input),
        },
      );
      setBundle(next);
      return request<BrandView>("/api/kely/brand");
    });
    if (saved) {
      setFallbackId(null);
      setIntake(
        strategy === "use_materials"
          ? "materials"
          : strategy === "use_preferences"
            ? "preferences"
            : null,
      );
      if (strategy === "decide_for_me")
        requestAnimationFrame(() =>
          document.getElementById("brand-overview-title")?.focus(),
        );
    }
  }
  async function upload(
    file: File,
    role: BrandMaterial["role"],
    label: string,
    fallbackForSourceId?: string,
  ) {
    if (!data.brand) return false;
    let fileKey = uploadKeys.current.get(file);
    if (!fileKey) {
      fileKey = crypto.randomUUID();
      uploadKeys.current.set(file, fileKey);
    }
    const values = {
      role,
      label,
      version: String(data.brand.version),
      ...(fallbackForSourceId ? { fallbackForSourceId } : {}),
    };
    const query = new URLSearchParams({
      ...values,
      commandKey: data.commandKey("upload", { ...values, fileKey }),
    });
    return data.change(() =>
      uploadRaster<BrandView>("/api/kely/brand/upload?" + query, file),
    );
  }
  async function importLink(input: { label: string; sourceUrl: string }) {
    if (!data.brand) return null;
    const values = { ...input, version: data.brand.version };
    let imported: BrandImportResult | null = null;
    const success = await data.change(async () => {
      const result = await request<BrandImportResult>(
        "/api/kely/brand/import",
        {
          ...values,
          commandKey: data.commandKey("import", values),
        },
      );
      imported = result;
      if (result.bundle) setBundle(result.bundle);
      return result.brand;
    });
    return success ? imported : null;
  }
  function openAnalysis(id: string | null) {
    setAnalysisRequest((current) => ({
      id,
      sequence: (current?.sequence ?? 0) + 1,
    }));
    selectSection("analysis");
    requestAnimationFrame(() =>
      document.getElementById("brand-panel-analysis")?.focus(),
    );
  }
  function closeAnalysis() {
    selectSection("materials");
    requestAnimationFrame(() =>
      document.getElementById("brand-tab-materials")?.focus(),
    );
  }
  function undo(eventId: string) {
    const input = { eventId };
    void data.change(() =>
      request<BrandView>("/api/kely/brand/undo", {
        eventId,
        commandKey: data.commandKey("undo", input),
      }),
    );
  }
  return (
    <section className="brand-workspace">
      <div className="page-heading">
        <div>
          <h1>Your brand.</h1>
          <p className="section-description">
            The details that make every post yours.
          </p>
        </div>
      </div>
      {!canEdit && (
        <div className="warning-note">
          <p>
            Your saved brand stays available. Changes need an active plan or
            remaining purchased credits.
          </p>
          <button className="text-button" onClick={onBilling}>
            View plan & credits
            <ArrowRight size={14} />
          </button>
        </div>
      )}
      <nav
        className="brand-section-nav"
        aria-label="Brand sections"
        role="tablist"
      >
        {(
          [
            { key: "overview", label: "Overview", icon: Sparkles },
            { key: "style", label: "Style", icon: Palette },
            { key: "materials", label: "Materials", icon: ImagePlus },
          ] as const
        ).map((item) => (
          <button
            key={item.key}
            type="button"
            id={`brand-tab-${item.key}`}
            role="tab"
            aria-selected={
              section === item.key ||
              (item.key === "materials" && section === "analysis")
            }
            aria-controls={
              item.key === "materials" && section === "analysis"
                ? "brand-panel-analysis"
                : `brand-panel-${item.key}`
            }
            tabIndex={
              section === item.key ||
              (item.key === "materials" && section === "analysis")
                ? 0
                : -1
            }
            onKeyDown={(event) => moveSection(event, item.key)}
            onClick={() => selectSection(item.key)}
          >
            <item.icon size={16} />
            {item.label}
          </button>
        ))}
      </nav>
      {data.loading ? (
        <div className="brand-loading" role="status">
          Opening your private brand workspace…
        </div>
      ) : !data.brand ? (
        <div className="brand-empty-note">
          <p>
            Brand settings could not be loaded. Your saved posts are unchanged.
          </p>
          <button
            className="button secondary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await data.reload();
              })
            }
          >
            Try loading Brand again
          </button>
        </div>
      ) : (
        <>
          <div
            id="brand-panel-overview"
            role="tabpanel"
            aria-labelledby="brand-tab-overview"
            hidden={section !== "overview"}
          >
            <BrandOverview
              brand={data.brand}
              bundle={currentBundle}
              error={bundleError}
              busy={locked}
              onRefresh={() =>
                void run(async () => {
                  await data.reload();
                  await refreshBundle();
                })
              }
              onStrategy={(strategy) => void chooseStrategy(strategy)}
              onAdd={(sourceId) => {
                setFallbackId(sourceId ?? null);
                setIntake("materials");
              }}
              onAnalysis={openAnalysis}
              onContinue={onContinue}
              onUndo={undo}
              intakeOpen={intake !== null}
              onSection={(next) => {
                selectSection(next);
              }}
            />
            <details className="brand-business-details">
              <summary>About your business</summary>
              {businessFacts}
            </details>
            {intake === "materials" && (
              <div ref={intakeElement} className="source-intake-sheet">
                <BrandMaterials
                  key={fallbackId ?? "source-intake"}
                  brand={data.brand}
                  bundle={currentBundle}
                  busy={locked}
                  compact
                  fallbackForSourceId={fallbackId ?? undefined}
                  onUpload={upload}
                  onLink={importLink}
                  onArchive={() => {}}
                />
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={closeIntake}
                >
                  Done adding sources
                </button>
              </div>
            )}
            {intake === "preferences" && (
              <div ref={intakeElement}>
                <SourcePreferences
                  brand={data.brand}
                  busy={locked}
                  onSave={(value) => rule("voice", value)}
                  onDetails={() => selectSection("style")}
                  onDone={closeIntake}
                />
              </div>
            )}
          </div>
          <div
            id="brand-panel-style"
            role="tabpanel"
            aria-labelledby="brand-tab-style"
            hidden={section !== "style"}
          >
            <details className="brand-direction-details">
            <summary>Colors, type & layout</summary>
            <ArtDirectionEditor
              brand={data.brand}
              busy={locked}
              onMaterials={() => setSection("materials")}
              onSave={(direction) => {
                const input = { direction, version: data.brand!.version };
                return data.change(() =>
                  request<BrandView>("/api/kely/brand/direction", {
                    ...input,
                    commandKey: data.commandKey("direction", input),
                  }),
                );
              }}
            />
            </details>
            <div className="brand-columns">
              <BrandMemory busy={locked} onRemember={data.remember} />
              <details className="brand-rules-details">
              <summary>Audience & default preferences</summary>
              <BrandRulesEditor
                brand={data.brand}
                busy={locked}
                onRule={(field, value) => void rule(field, value)}
              />
              </details>
            </div>
            <details className="brand-history-details"><summary>Preference history</summary><BrandHistory brand={data.brand} busy={locked} onUndo={undo} /></details>
          </div>
          <div
            id="brand-panel-materials"
            role="tabpanel"
            aria-labelledby="brand-tab-materials"
            hidden={section !== "materials"}
          >
            <BrandMaterials
              brand={data.brand}
              bundle={currentBundle}
              busy={locked}
              onUpload={upload}
              onLink={importLink}
              onArchive={(id) =>
                void data.change(() =>
                  request<BrandView>(
                    "/api/kely/brand-materials/" +
                      encodeURIComponent(id) +
                      "/archive",
                    { version: data.brand!.version },
                  ),
                )
              }
            />
          </div>
          <div
            id="brand-panel-analysis"
            role="tabpanel"
            aria-labelledby="brand-tab-materials"
            tabIndex={-1}
            hidden={section !== "analysis"}
          >
            <button
              type="button"
              className="text-button brand-analysis-back"
              onClick={closeAnalysis}
            >
              Back to assets & references
            </button>
            {analysisOpened && (
              <BrandAnalysis
                data={data}
                busy={busy}
                canEdit={canEdit}
                availableCredits={availableCredits}
                run={run}
                onError={onError}
                onAccountRefresh={onAccountRefresh}
                onBilling={onBilling}
                onMaterials={closeAnalysis}
                bundle={currentBundle}
                onBundleRefresh={refreshBundle}
                openRequest={analysisRequest}
              />
            )}
          </div>
        </>
      )}
    </section>
  );
}

function BrandOverview({
  brand,
  bundle,
  error,
  busy,
  onRefresh,
  onStrategy,
  onAdd,
  onAnalysis,
  onContinue,
  onUndo,
  intakeOpen,
  onSection,
}: {
  brand: BrandView;
  bundle: SourceBundleView | null;
  error: string;
  busy: boolean;
  onRefresh: () => void;
  onStrategy: (strategy: SourceStrategy) => void;
  onAdd: (sourceId?: string) => void;
  onAnalysis: (id: string | null) => void;
  onContinue: () => void;
  onUndo: (id: string) => void;
  intakeOpen: boolean;
  onSection: (section: "style" | "materials" | "analysis") => void;
}) {
  const action = bundle?.summary.nextAction;
  const fallback = bundle?.completeness.recommendations.find(
    (gap) => gap.code === "social_screenshots_recommended",
  )?.sourceId;
  const proposal = bundle?.preferences.find(
    (item) => item.state === "proposed" && item.analysisId,
  );
  const latest = [...brand.events].sort((a, b) => b.version - a.version)[0];
  const usableSources =
    bundle?.sources.filter(
      (source) => source.state !== "needs_upload" && source.materials.length > 0,
    ) ?? [];
  const readiness = [
    {
      label: "Audience",
      value: brand.rules.audience || "Not described yet",
      ready: Boolean(brand.rules.audience),
    },
    {
      label: "Look",
      value: brand.rules.artDirection
        ? "Visual direction saved"
        : brand.rules.palette
          ? `${brand.rules.palette} palette saved`
          : "Kely will propose a direction",
      ready: Boolean(brand.rules.artDirection || brand.rules.palette),
    },
    {
      label: "Voice",
      value:
        brand.rules.voice ||
        (brand.rules.headlines === "shorter"
          ? "Shorter headlines"
          : "Not described yet"),
      ready: Boolean(
        brand.rules.voice || brand.rules.headlines === "shorter",
      ),
    },
    {
      label: "Sources",
      value: usableSources.length
        ? `${usableSources.length} usable source${usableSources.length === 1 ? "" : "s"}`
        : bundle?.sources.length
          ? "Saved link needs screenshots"
          : "No assets yet — optional",
      ready: usableSources.length > 0,
      status:
        !usableSources.length && bundle?.completeness.status === "blocked"
          ? "Needs upload"
          : undefined,
    },
  ];
  const strategyChoice = (
    <div
      className="source-strategy-choice"
      role="group"
      aria-label="Creative starting point"
    >
      {(Object.keys(strategyLabels) as SourceStrategy[]).map((strategy) => (
        <button
          type="button"
          key={strategy}
          disabled={busy || !bundle}
          aria-pressed={bundle?.strategy === strategy}
          onClick={() => onStrategy(strategy)}
        >
          <strong>{strategyLabels[strategy]}</strong>
          <span>
            {strategy === "use_materials"
              ? "A link, screenshots, or exact originals"
              : strategy === "use_preferences"
                ? "Tell Kely what should stay consistent"
                : "Let Kely propose missing creative choices"}
          </span>
        </button>
      ))}
    </div>
  );
  function nextAction() {
    if (action === "add_material") onAdd();
    else if (action === "upload_screenshots") onAdd(fallback);
    else if (action === "review_proposal")
      onAnalysis(proposal?.analysisId ?? null);
    else if (action === "analyze_references") onAnalysis(null);
    else onContinue();
  }
  const actionLabels = {
    add_material: "Add a source",
    upload_screenshots: "Add screenshots",
    analyze_references: "Choose references to analyze",
    review_proposal: "Review proposed direction",
    continue: "Continue to my post",
  };
  return (
    <section className="brand-overview" aria-labelledby="brand-overview-title">
      <div className="brand-overview-intro">
        <h2 id="brand-overview-title" tabIndex={-1}>
          {bundle?.strategy
            ? "What Kely knows."
            : "What should your posts feel like?"}
        </h2>
      </div>
      {!bundle ? (
        <p role="status">
          {error || "Reading your saved sources…"}
          {error && (
            <button className="text-button" disabled={busy} onClick={onRefresh}>
              Refresh saved sources
            </button>
          )}
        </p>
      ) : (
        <>
          {!bundle.strategy ? (
            strategyChoice
          ) : (
            <details className="source-strategy-details">
              <summary>
                {strategyLabels[bundle.strategy]} · change
              </summary>
              {strategyChoice}
            </details>
          )}
          <dl className="brand-readiness-grid" aria-label="Brand readiness">
            {readiness.map((item) => (
              <div key={item.label}>
                <dt>
                  {item.label}
                  <span
                    className={
                      item.ready
                        ? "is-ready"
                        : item.status
                          ? "is-needed"
                          : "is-optional"
                    }
                  >
                    {item.ready ? "Ready" : item.status || "Optional"}
                  </span>
                </dt>
                <dd dir="auto">{item.value}</dd>
              </div>
            ))}
          </dl>
          {brand.materials.some((material) => material.kind === "image") && (
            <div className="brand-overview-materials">
              <div className="brand-section-heading"><h3>Your materials</h3><button className="text-button" onClick={() => onSection("materials")}>View all</button></div>
              <div className="brand-thumbnail-strip">
                {brand.materials.filter((material) => material.kind === "image").slice(0, 4).map((material) => (
                  <figure key={material.id}>
                    <Image src={"/api/kely/brand-materials/" + encodeURIComponent(material.id)} alt={material.label} width={120} height={120} unoptimized />
                    <figcaption dir="auto">{material.label}</figcaption>
                  </figure>
                ))}
              </div>
            </div>
          )}
          {bundle.completeness.blockers.length > 0 && (
            <div className="warning-note">
              <strong>Needed for your selected approach</strong>
              <ul>
                {bundle.completeness.blockers.map((gap) => (
                  <li key={gap.code + (gap.sourceId ?? gap.materialId ?? "")}>
                    {gap.message}
                  </li>
                ))}
              </ul>
              <p>
                Add the missing material or choose another starting point.
              </p>
            </div>
          )}
          {bundle.completeness.recommendations.length > 0 && (
            <details
              className="source-recommendations"
              open={action === "upload_screenshots"}
            >
              <summary>For a closer match · optional</summary>
              <ul>
                {bundle.completeness.recommendations.map((gap) => (
                  <li key={gap.code + (gap.sourceId ?? "")}>{gap.message}</li>
                ))}
              </ul>
            </details>
          )}
          {!intakeOpen && action && (
            <div className="source-next-action">
              <button
                className="button primary"
                type="button"
                disabled={busy}
                onClick={nextAction}
              >
                {actionLabels[action]}
                <ArrowRight size={15} />
              </button>
              {action !== "continue" &&
                bundle.completeness.status !== "blocked" && (
                  <button
                    className="text-button"
                    type="button"
                    disabled={busy}
                    onClick={onContinue}
                  >
                    Continue without{" "}
                    {action === "upload_screenshots"
                      ? "more screenshots"
                      : "analysis"}
                  </button>
                )}
              {action === "continue" && (
                <button
                  className="text-button"
                  type="button"
                  disabled={busy}
                  onClick={() => onAdd()}
                >
                  Add an asset or reference
                </button>
              )}
            </div>
          )}
          <details className="source-bundle-details">
            <summary>Review sources and confirmed preferences</summary>
            <div className="source-bundle-list">
              {bundle.sources.map((source) => (
                <SourceRow
                  key={source.id}
                  source={source}
                  busy={busy}
                  onFallback={() => onAdd(source.id)}
                />
              ))}
            </div>
            {bundle.preferences.map((preference, index) => (
              <div
                className="source-preference-row"
                key={preference.field + index}
              >
                <span className="brand-label">
                  {preference.state === "confirmed" ? "Confirmed" : "Proposed"}
                </span>
                <span>
                  {fieldLabel(preference.field)} ·{" "}
                  {fieldValue(preference.field, preference.value)}
                </span>
                {preference.state === "proposed" && preference.analysisId && (
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => onAnalysis(preference.analysisId!)}
                  >
                    Review, then choose
                  </button>
                )}
              </div>
            ))}
            <button
              className="text-button"
              type="button"
              onClick={() => onSection("style")}
            >
              All preferences & Undo history
            </button>
          </details>
          <details className="brand-audit-details">
            <summary>History & details</summary>
            {latest && !latest.undoOf && (
              <div className="source-last-update" role="status">
                <span>Latest confirmed update: {fieldLabel(latest.field)}.</span>
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => onUndo(latest.id)}
                >
                  Undo this update
                  <Undo2 size={14} />
                </button>
              </div>
            )}
            <p className="brand-overview-note">
              Only confirmed Brand choices are reused automatically. Existing
              posts keep the inputs they were created with.
            </p>
          </details>
        </>
      )}
    </section>
  );
}

function SourceRow({
  source,
  busy,
  onFallback,
}: {
  source: BrandSource;
  busy: boolean;
  onFallback: () => void;
}) {
  return (
    <article className="source-bundle-row">
      <div>
        <strong dir="auto">{source.label}</strong>
        <span className="brand-label">
          {source.role === "original" ? "Exact asset" : "Reference"}
        </span>
        {source.state !== "available" && (
          <span className="brand-label">
            {source.state === "partial"
              ? "Partial preview"
              : "Needs screenshots"}
          </span>
        )}
        {source.fallbackFor && (
          <span className="brand-label">Linked screenshot fallback</span>
        )}
      </div>
      {source.state === "partial" && (
        <p>Public preview only, not the complete page or post.</p>
      )}
      {source.state !== "available" &&
        (source.kind === "website" || source.kind === "social") && (
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={onFallback}
          >
            Add screenshots for this link
          </button>
        )}
      <details>
        <summary>Source details</summary>
        {source.submittedUrl && (
          <p className="brand-source-url" dir="auto">
            {source.submittedUrl}
          </p>
        )}
        <p>
          {source.materials.filter((item) => item.kind === "image").length}{" "}
          saved image(s)
          {source.acquiredAt
            ? ` · acquired ${displayDate(source.acquiredAt)}`
            : " · no pixels acquired from this link"}
          .
        </p>
        <p>
          {source.kind === "legacy"
            ? "Earlier saved material; retrieval outcome was not recorded."
            : source.role === "original"
              ? "Owner-designated for exact reuse. Saving does not select placement or verify licensing."
              : "Visual guidance only. It cannot become reusable original artwork automatically."}
        </p>
      </details>
    </article>
  );
}

function SourcePreferences({
  brand,
  busy,
  onSave,
  onDetails,
  onDone,
}: {
  brand: BrandView;
  busy: boolean;
  onSave: (value: string) => Promise<boolean | undefined>;
  onDetails: () => void;
  onDone: () => void;
}) {
  const [voice, setVoice] = useState(brand.rules.voice ?? "");
  const [saved, setSaved] = useState(false);
  return (
    <form
      className="source-preference-intake"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave(voice.trim()).then((success) => {
          if (success) setSaved(true);
        });
      }}
    >
      <label>
        What should the writing feel like?
        <textarea
          value={voice}
          disabled={busy}
          maxLength={500}
          rows={3}
          onChange={(event) => {
            setVoice(event.target.value);
            setSaved(false);
          }}
          placeholder="Warm and concise. Short sentences. Avoid hype and exclamation marks."
        />
      </label>
      <p className="brand-helper">
        Save your exact words as a standing voice preference. This free step
        does not interpret colors, identify fonts, or analyze images.
      </p>
      <button
        className="button primary"
        disabled={
          busy || !voice.trim() || voice.trim() === (brand.rules.voice ?? "")
        }
      >
        Remember this voice
      </button>
      {saved && (
        <p role="status">
          Voice confirmed for future preparation. Undo remains available above.
        </p>
      )}
      <div className="source-next-action">
        <button type="button" className="text-button" onClick={onDetails}>
          Choose exact colors or typography
        </button>
        <button type="button" className="text-button" onClick={onDone}>
          Done describing the style
        </button>
      </div>
    </form>
  );
}

function BrandRulesEditor({
  brand,
  busy,
  onRule,
}: {
  brand: BrandView;
  busy: boolean;
  onRule: (field: BrandField, value: string | null) => void;
}) {
  const [audience, setAudience] = useState(brand.rules.audience);
  useEffect(() => setAudience(brand.rules.audience), [brand.rules.audience]);
  return (
    <section className="brand-rules">
      <h2>Your brand preferences</h2>
      <p className="brand-helper">
        Confirmed choices for future work. Earlier posts stay unchanged.
      </p>
      <form
        className="brand-audience-form"
        onSubmit={(event) => {
          event.preventDefault();
          onRule("audience", audience.trim());
        }}
      >
        <label htmlFor="brand-audience">Who do you usually speak to?</label>
        <textarea
          id="brand-audience"
          value={audience}
          onChange={(event) => setAudience(event.target.value)}
          maxLength={500}
          rows={2}
          placeholder="Local coffee lovers, independent shop owners…"
          disabled={busy}
        />
        <button
          className="button secondary"
          disabled={busy || audience.trim() === brand.rules.audience}
        >
          Save audience
          <Check size={14} />
        </button>
      </form>
      <fieldset className="brand-palette-field" disabled={busy}>
        <legend>Default palette</legend>
        <p className="brand-helper">
          Used when a post does not need its own custom direction.
        </p>
        <div className="brand-palette-options">
          {paletteOptions.map((option) => (
            <button
              className={"brand-palette-option palette-" + option.value}
              key={option.value}
              type="button"
              aria-pressed={brand.rules.palette === option.value}
              onClick={() => onRule("palette", option.value)}
            >
              <span className="brand-palette-swatch" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <strong>
                {option.label}
                {brand.rules.palette === option.value && <Check size={14} />}
              </strong>
              <small>{option.description}</small>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="text-button"
          disabled={busy || brand.rules.palette === null}
          onClick={() => onRule("palette", null)}
        >
          Clear default palette
        </button>
      </fieldset>
      <div className="brand-headline-rule">
        <label>
          <input
            type="checkbox"
            checked={brand.rules.headlines === "shorter"}
            disabled={busy}
            onChange={(event) =>
              onRule("headlines", event.target.checked ? "shorter" : "default")
            }
          />
          Prefer shorter headlines
        </label>
        <span className="brand-label">For future posts</span>
      </div>
    </section>
  );
}

function BrandMaterials({
  brand,
  bundle,
  busy,
  compact = false,
  fallbackForSourceId,
  onUpload,
  onLink,
  onArchive,
}: {
  brand: BrandView;
  bundle: SourceBundleView | null;
  busy: boolean;
  compact?: boolean;
  fallbackForSourceId?: string;
  onUpload: (
    file: File,
    role: BrandMaterial["role"],
    label: string,
    fallbackForSourceId?: string,
  ) => Promise<boolean>;
  onLink: (input: {
    label: string;
    sourceUrl: string;
  }) => Promise<BrandImportResult | null>;
  onArchive: (id: string) => void;
}) {
  const id = useId();
  const [kind, setKind] = useState<"image" | "link">(
    compact && !fallbackForSourceId ? "link" : "image",
  );
  const [fallbackId, setFallbackId] = useState(fallbackForSourceId ?? "");
  const [role, setRole] = useState<BrandMaterial["role"]>("reference");
  const [label, setLabel] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [validation, setValidation] = useState("");
  const [importOutcome, setImportOutcome] = useState<BrandImportOutcome | null>(
    null,
  );
  const [importedSource, setImportedSource] = useState<BrandSource | null>(
    null,
  );
  const [uploadSaved, setUploadSaved] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const images = brand.materials.filter(
    (material) => material.kind === "image",
  ).length;
  function chooseFile(next: File | undefined) {
    setValidation("");
    setUploadSaved(false);
    setFile(null);
    if (!next) return;
    if (!["image/png", "image/jpeg"].includes(next.type)) {
      setValidation(
        "Choose a PNG or JPEG. SVG, PDF, animated images, and font files are not supported.",
      );
      return;
    }
    if (next.size === 0 || next.size > 5 * 1024 * 1024) {
      setValidation("Choose a nonempty image no larger than 5 MiB.");
      return;
    }
    setFile(next);
    if (!label) setLabel(next.name.replace(/\.[^.]+$/, "").slice(0, 100));
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !label.trim()) return;
    let success: boolean;
    if (kind === "image") {
      success = Boolean(
        file &&
          (await onUpload(
            file,
            role,
            label.trim(),
            role === "reference" && fallbackId ? fallbackId : undefined,
          )),
      );
      if (success) setUploadSaved(true);
    } else {
      const result = await onLink({
        label: label.trim(),
        sourceUrl: sourceUrl.trim(),
      });
      setImportOutcome(result?.outcome ?? null);
      setImportedSource(result?.source ?? null);
      success = Boolean(result);
    }
    if (success) {
      setFile(null);
      setLabel("");
      setSourceUrl("");
      setValidation("");
      if (input.current) input.current.value = "";
    }
  }
  return (
    <section className={"brand-materials" + (compact ? " is-intake" : "")}>
      <div className="brand-section-heading">
        <div>
          <h2>
            {fallbackId ? "Add those posts." : "Your materials."}
          </h2>
          <p>
            {fallbackId
              ? "Upload screenshots of the exact posts. They stay linked to your original source."
              : "Photos, logos, links and posts you love."}
          </p>
        </div>
        <span className="brand-label">
          {images ? `${images} saved image${images === 1 ? "" : "s"}` : "No assets yet"}
        </span>
      </div>
      <div className="brand-material-columns">
        <form className="brand-material-form" onSubmit={submit}>
          <fieldset disabled={busy}>
            <legend>Add a source</legend>
            <div
              className="brand-input-choice"
              role="group"
              aria-label="Material source"
            >
              <button
                type="button"
                aria-pressed={kind === "image"}
                onClick={() => setKind("image")}
              >
                <Upload size={15} />
                Upload files
              </button>
              <button
                type="button"
                aria-pressed={kind === "link"}
                onClick={() => setKind("link")}
              >
                <Link2 size={15} />
                Paste a link
              </button>
            </div>
            {kind !== "image" && (
              <p className="brand-helper">
                Link imports are always references. Kely never assumes they are
                reusable originals or licensed assets.
              </p>
            )}
            {kind === "image" ? (
              <label className="brand-file-input" htmlFor={id + "-file"}>
                <ImagePlus size={24} />
                <strong>{file ? file.name : "Choose a PNG or JPEG"}</strong>
                <span>
                  {file
                    ? `${(file.size / 1024 / 1024).toFixed(2)} MiB · ready to upload`
                    : "One image, up to 5 MiB"}
                </span>
                <input
                  id={id + "-file"}
                  ref={input}
                  type="file"
                  accept="image/png,image/jpeg,.png,.jpg,.jpeg"
                  onChange={(event) => chooseFile(event.target.files?.[0])}
                />
              </label>
            ) : (
              <>
                <label htmlFor={id + "-url"}>
                  Website, profile, or publication link
                </label>
                <input
                  id={id + "-url"}
                  type="url"
                  pattern="https://.*"
                  maxLength={2000}
                  placeholder="https://…"
                  value={sourceUrl}
                  onChange={(event) => setSourceUrl(event.target.value)}
                  required
                />
                <p className="brand-helper">
                  Kely imports up to three public PNG/JPEG preview images.
                  Closed or incomplete social previews need uploaded
                  screenshots. No AI analysis runs here.
                </p>
              </>
            )}
            {kind === "image" && file && (
              <>
                <label htmlFor={id + "-role"}>
                  How may Kely use this file?
                </label>
                <select
                  id={id + "-role"}
                  value={role}
                  onChange={(event) => {
                    setRole(event.target.value as BrandMaterial["role"]);
                    if (event.target.value === "original") setFallbackId("");
                  }}
                >
                  <option value="reference">Reference only — do not place it</option>
                  <option value="original">May appear in future posts</option>
                </select>
                <p className="brand-helper">
                  Choose “reference only” for posts you admire. Only mark files
                  you are allowed to reuse as originals.
                </p>
              </>
            )}
            {kind === "image" &&
              role === "reference" &&
              Boolean(
                bundle?.sources.some(
                  (source) =>
                    source.kind === "social" || source.kind === "website",
                ),
              ) && (
                <label>
                  Screenshot for a saved link{" "}
                  <span className="field-hint">optional</span>
                  <select
                    value={fallbackId}
                    onChange={(event) => setFallbackId(event.target.value)}
                  >
                    <option value="">A separate reference</option>
                    {bundle!.sources
                      .filter(
                        (source) =>
                          source.kind === "social" || source.kind === "website",
                      )
                      .map((source) => (
                        <option key={source.id} value={source.id}>
                          {source.label}
                        </option>
                      ))}
                  </select>
                </label>
              )}
            <label htmlFor={id + "-label"}>A useful name</label>
            <input
              id={id + "-label"}
              maxLength={100}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Our logo, a post we like, a product photo…"
              required
            />
            {validation && (
              <p className="warning-note" role="alert">
                {validation}
              </p>
            )}
            {importOutcome && kind === "link" && (
              <div
                className={`brand-import-outcome is-${importOutcome.status}`}
                role="status"
              >
                <strong>
                  {importOutcome.status === "imported"
                    ? "References imported"
                    : importOutcome.status === "partial"
                      ? "Partial public preview"
                      : "Upload recommended"}
                </strong>
                <p>{importOutcome.message}</p>
                {importedSource &&
                  importedSource.state !== "available" &&
                  (importedSource.kind === "social" ||
                    importedSource.kind === "website") && (
                    <button
                      className="text-button"
                      type="button"
                      onClick={() => {
                        setKind("image");
                        setRole("reference");
                        setFallbackId(importedSource.id);
                      }}
                    >
                      Upload screenshots for this link
                    </button>
                  )}
              </div>
            )}
            {uploadSaved && kind === "image" && (
              <p role="status">
                Saved privately{fallbackId ? " and linked to this source" : ""}.
                No analysis started.
              </p>
            )}
            <button
              className="button primary full-width"
              disabled={
                busy ||
                !label.trim() ||
                (kind === "image" && (!file || images >= 20))
              }
            >
              {kind === "image"
                ? "Add image"
                : "Add references"}
              <ArrowRight size={15} />
            </button>
          </fieldset>
          <p className="brand-helper">
            Originals can appear in your posts. References guide the style.
          </p>
          <details className="brand-future-details">
            <summary>File limits</summary>
            <p>
              20 active raster images; 100 retained material records and 100 MiB
              retained storage. Archiving does not reset the lifetime quota.
              Images are limited to 16 million pixels, one frame, and 8192 px
              per side.
            </p>
          </details>
        </form>
        {!compact && (
          <div
            className="brand-material-library"
            aria-label="Saved brand materials"
          >
            {brand.materials.length ? (
              <div className="brand-material-grid">
                {brand.materials.map((material) => (
                  <article className="brand-material-card" key={material.id}>
                    <div
                      className={
                        "brand-material-image" +
                        (material.kind === "link" ? " is-link" : "")
                      }
                    >
                      {material.kind === "image" ? (
                        <Image
                          src={
                            "/api/kely/brand-materials/" +
                            encodeURIComponent(material.id)
                          }
                          alt={
                            material.label +
                            " — " +
                            material.role +
                            " saved source image"
                          }
                          width={material.width ?? 300}
                          height={material.height ?? 220}
                          unoptimized
                        />
                      ) : (
                        <>
                          <Link2 size={27} />
                          <span>Import source</span>
                        </>
                      )}
                    </div>
                    <div className="brand-material-copy">
                      <div>
                        <span className="brand-label">
                          {material.role === "original"
                            ? "Exact asset"
                            : "Reference"}
                        </span>
                        <span className="brand-label">v{material.version}</span>
                      </div>
                      <h3 dir="auto">{material.label}</h3>
                      <p>
                        {material.kind === "link"
                          ? material.sourceId
                            ? "Source outcome is saved in What Kely knows"
                            : "Earlier link · retrieval outcome was not recorded"
                          : material.role === "reference"
                            ? "Reference saved · analysis optional"
                            : brand.rules.artDirection?.logoMaterialId ===
                                material.id
                              ? "Selected logo for new posts"
                              : brand.rules.artDirection?.heroMaterialIds.includes(
                                    material.id,
                                  )
                                ? "Selected imagery for new posts"
                                : "Original available for selection"}
                      </p>
                      <small>
                        User-provided · {displayDate(material.createdAt)}
                      </small>
                      {material.kind === "image" && (
                        <small>
                          {material.width} × {material.height} px · normalized
                          PNG
                        </small>
                      )}
                      {material.sourceUrl && (
                        <p className="brand-source-url" dir="auto">
                          {material.sourceUrl}
                        </p>
                      )}
                      {material.contentHash && (
                        <details className="brand-material-proof">
                          <summary>File verification</summary>
                          <p>SHA-256 of the normalized image</p>
                          <code>{material.contentHash}</code>
                        </details>
                      )}
                      <button
                        type="button"
                        className="text-button"
                        disabled={busy}
                        onClick={() => onArchive(material.id)}
                        aria-label={
                          "Archive " + material.label + " from future selection"
                        }
                      >
                        <Archive size={13} />
                        Archive from Brand
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="brand-material-empty">
                <ImagePlus size={36} strokeWidth={1.1} />
                <h3>Start with what you already have.</h3>
                <p>
                  A logo, a product photo, or two recent posts are usually
                  enough. You can also continue without any files.
                </p>
              </div>
            )}
            <p className="brand-helper">
              Archive removes a material from future selection. It does not
              delete bytes needed by older saved work or rewrite a past post.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
