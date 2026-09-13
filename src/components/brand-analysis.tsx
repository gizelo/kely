"use client";

import Image from "next/image";
import { ArrowRight, Check, RefreshCw } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type { AnalysisView } from "../shared/analysis";
import type { BrandView, SourceBundleView } from "../shared/brand";
import { displayDate, request, RequestError } from "./api";
import type { BrandData, RunBrandAction } from "./brand-data";
import { DirectionSummary } from "./art-direction-editor";
import { CostDetails } from "./origin";

const base = "/api/kely/brand-analyses";
const statusLabels: Record<AnalysisView["status"], string> = {
  quoted: "Quote to review",
  queued: "Queued",
  running: "Analysis in progress",
  completed: "Proposal ready",
  failed: "Failed · saved sources preserved",
  uncertain: "Outcome needs review",
};

function AnalysisOrigin({ analysis }: { analysis: AnalysisView }) {
  if (analysis.origin === "openai") return null;
  return (
    <div
      className="analysis-origin is-simulated"
    >
      <strong>
        Example
      </strong>
      <span>
        Sample proposal, not an analysis of your images.
      </span>
    </div>
  );
}

export function BrandAnalysis({
  data,
  busy,
  canEdit,
  availableCredits,
  run,
  onError,
  onAccountRefresh,
  onBilling,
  onMaterials,
  bundle,
  onBundleRefresh,
  openRequest,
}: {
  data: BrandData;
  busy: boolean;
  canEdit: boolean;
  availableCredits: number;
  run: RunBrandAction;
  onError: (error: unknown) => void;
  onAccountRefresh: () => Promise<unknown>;
  onBilling: () => void;
  onMaterials: () => void;
  bundle: SourceBundleView | null;
  onBundleRefresh: () => Promise<void>;
  openRequest?: { id: string | null; sequence: number };
}) {
  const [analyses, setAnalyses] = useState<AnalysisView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [materialIds, setMaterialIds] = useState<string[]>([]);
  const [guidance, setGuidance] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [pollingPaused, setPollingPaused] = useState(false);
  const [actionCode, setActionCode] = useState("");
  const [clock, setClock] = useState(Date.now);
  const [appliedEvent, setAppliedEvent] = useState<{
    analysisId: string;
    eventId: string;
  } | null>(null);
  const requested = useRef(openRequest);
  const detail = useRef<HTMLElement>(null);
  const selected = analyses.find((item) => item.id === selectedId);
  const rasters =
    data.brand?.materials.filter(
      (item) =>
        item.kind === "image" &&
        bundle?.completeness.selectableAnalysisMaterialIds.includes(item.id),
    ) ?? [];
  const pending =
    selected?.status === "queued" || selected?.status === "running";
  const missingSelection = materialIds.some(
    (id) => !rasters.some((item) => item.id === id),
  );
  const sync = useCallback(
    (next: AnalysisView) =>
      setAnalyses((items) => [
        next,
        ...items.filter((item) => item.id !== next.id),
      ]),
    [],
  );

  useEffect(() => {
    requested.current = openRequest;
    if (!openRequest) return;
    setSelectedId(openRequest.id);
    setPollingPaused(false);
    setActionCode("");
    setLoadError("");
  }, [openRequest]);

  useEffect(() => {
    const controller = new AbortController();
    void request<{ analyses: AnalysisView[] }>(
      base,
      undefined,
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted) {
          setAnalyses(result.analyses);
          setSelectedId(
            requested.current
              ? requested.current.id
              : (result.analyses[0]?.id ?? null),
          );
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setLoadError(
            error instanceof Error
              ? error.message
              : "Saved analyses could not be loaded.",
          );
          if (error instanceof RequestError && error.status === 401)
            onError(error);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [onError]);

  const status = selected?.status;
  useEffect(() => {
    if (!selectedId || !pending || pollingPaused) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const next = await request<AnalysisView>(
          base + "/" + selectedId,
          undefined,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        sync(next);
        if (next.status === "queued" || next.status === "running")
          timer = setTimeout(poll, 1800);
        else await Promise.all([onAccountRefresh(), onBundleRefresh()]);
      } catch (error) {
        if (!controller.signal.aborted) {
          setPollingPaused(true);
          setLoadError(
            "Status refresh paused. Your saved analysis is preserved; refresh it to continue.",
          );
          if (error instanceof RequestError && error.status === 401)
            onError(error);
        }
      }
    }
    timer = setTimeout(poll, 1000);
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [
    selectedId,
    status,
    pending,
    pollingPaused,
    sync,
    onAccountRefresh,
    onBundleRefresh,
    onError,
  ]);

  useEffect(() => {
    if (status !== "quoted") return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [status]);

  function open(id: string | null) {
    setSelectedId(id);
    setPollingPaused(false);
    setLoadError("");
    setActionCode("");
    setClock(Date.now());
    if (id) requestAnimationFrame(() => detail.current?.focus());
  }
  async function refresh() {
    await run(async () => {
      if (selectedId)
        sync(await request<AnalysisView>(base + "/" + selectedId));
      else {
        const result = await request<{ analyses: AnalysisView[] }>(base);
        setAnalyses(result.analyses);
      }
      await Promise.all([data.reload(), onAccountRefresh(), onBundleRefresh()]);
      setPollingPaused(false);
      setLoadError("");
      setActionCode("");
    });
  }
  function toggle(id: string, checked: boolean) {
    setMaterialIds((current) =>
      checked ? [...current, id] : current.filter((item) => item !== id),
    );
  }
  async function quote(event: FormEvent) {
    event.preventDefault();
    if (
      !data.brand ||
      !bundle ||
      busy ||
      !canEdit ||
      materialIds.length < 1 ||
      materialIds.length > 3 ||
      missingSelection
    )
      return;
    await run(async () => {
      const next = await request<AnalysisView>(base + "/quote", {
        materialIds,
        guidance: guidance.trim(),
        version: data.brand!.version,
      });
      sync(next);
      open(next.id);
    });
  }
  async function accept() {
    if (!selected || selected.status !== "quoted" || busy) return;
    await run(async () => {
      try {
        const next = await request<AnalysisView>(
          base + "/" + selected.id + "/accept",
          {
            requestKey: data.commandKey("analysis-accept", { id: selected.id }),
          },
        );
        sync(next);
        setActionCode("");
        await onAccountRefresh();
      } catch (error) {
        if (error instanceof RequestError) setActionCode(error.code);
        throw error;
      }
    });
  }
  async function apply() {
    if (
      !selected ||
      !data.brand ||
      selected.status !== "completed" ||
      selected.applied
    )
      return;
    const input = { version: data.brand.version };
    const previousEvents = new Set(data.brand.events.map((event) => event.id));
    await data.change(async () => {
      const result = await request<{
        analysis: AnalysisView;
        brand: BrandView;
      }>(base + "/" + selected.id + "/apply", {
        ...input,
        commandKey: data.commandKey("analysis-apply:" + selected.id, input),
      });
      sync(result.analysis);
      const event = result.brand.events.find(
        (item) => item.field === "artDirection" && !previousEvents.has(item.id),
      );
      if (event)
        setAppliedEvent({ analysisId: selected.id, eventId: event.id });
      return result.brand;
    });
  }
  async function undoApplied() {
    if (!appliedEvent) return;
    const { eventId } = appliedEvent;
    const success = await data.change(() =>
      request<BrandView>("/api/kely/brand/undo", {
        eventId,
        commandKey: data.commandKey("undo", { eventId }),
      }),
    );
    if (success) {
      setAppliedEvent(null);
      requestAnimationFrame(() => detail.current?.focus());
    }
  }

  const proposal = selected?.proposal;
  const reuseIds = proposal
    ? [
        ...proposal.direction.heroMaterialIds,
        ...(proposal.direction.logoMaterialId
          ? [proposal.direction.logoMaterialId]
          : []),
      ]
    : [];
  const safeReuse = reuseIds.every(
    (id) =>
      selected?.selected.some(
        (item) => item.id === id && item.role === "original",
      ) &&
      data.brand?.materials.some(
        (item) =>
          item.id === id && item.role === "original" && item.kind === "image",
      ),
  );
  const expired =
    selected?.status === "quoted" &&
    new Date(selected.expiresAt).getTime() <= clock;
  const budgetBlocked = [
    "budget_exhausted",
    "budget_integrity",
    "attempt_uncertain",
  ].includes(actionCode);

  return (
    <section className="brand-analysis" aria-labelledby="brand-analysis-title">
      <div className="brand-section-heading">
        <div>
          <h2 id="brand-analysis-title">Find your visual direction.</h2>
          <p>
            Choose references for Kely to study.
          </p>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Refresh saved analyses"
          disabled={busy}
          onClick={() => void refresh()}
        >
          <RefreshCw size={16} />
        </button>
      </div>
      {loadError && (
        <p className="warning-note" role="alert">
          {loadError}{" "}
          <button
            className="text-button"
            disabled={busy}
            onClick={() => void refresh()}
          >
            Refresh saved state
          </button>
        </p>
      )}
      {loading ? (
        <p className="brand-loading" role="status">
          Loading saved directions…
        </p>
      ) : (
        <>
          <div className="analysis-navigation">
            <button
              className="button secondary"
              disabled={busy || !canEdit}
              onClick={() => open(null)}
            >
              Analyze references
            </button>
            {analyses.length > 0 && (
              <label>
                Saved analysis
                <select
                  value={selectedId ?? ""}
                  onChange={(event) => open(event.target.value || null)}
                >
                  <option value="">New selection</option>
                  {analyses.map((item) => (
                    <option key={item.id} value={item.id}>
                      {statusLabels[item.status]} ·{" "}
                      {item.selected[0]?.label ?? "Selected images"} ·{" "}
                      {displayDate(item.createdAt)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {!selected ? (
            <form onSubmit={quote} className="analysis-intake">
              <fieldset disabled={busy || !canEdit || !data.brand || !bundle}>
                <div className="analysis-selection-heading">
                  <strong>Choose 1–3 images</strong>
                  <span>{materialIds.length} selected</span>
                  <button
                    type="button"
                    className="text-button"
                    onClick={onMaterials}
                  >
                    Add materials
                    <ArrowRight size={14} />
                  </button>
                </div>
                <p className="brand-helper">
                  References guide the style. Only originals can be reused in your posts.
                </p>
                {!bundle && (
                  <p role="status">
                    Refresh the saved source bundle before selecting images. No
                    analysis starts while source availability is unknown.
                  </p>
                )}
                {rasters.length ? (
                  <div className="analysis-source-grid">
                    {rasters.map((material) => (
                      <label
                        className={
                          materialIds.includes(material.id) ? "selected" : ""
                        }
                        key={material.id}
                      >
                        <input
                          type="checkbox"
                          checked={materialIds.includes(material.id)}
                          disabled={
                            busy ||
                            !canEdit ||
                            (!materialIds.includes(material.id) &&
                              materialIds.length >= 3)
                          }
                          onChange={(event) =>
                            toggle(material.id, event.target.checked)
                          }
                        />
                        <Image
                          src={
                            "/api/kely/brand-materials/" +
                            encodeURIComponent(material.id)
                          }
                          alt={material.label + " source preview"}
                          width={material.width ?? 200}
                          height={material.height ?? 200}
                          unoptimized
                        />
                        <span>
                          {material.label}
                          <small>
                            {material.role === "reference"
                              ? "Reference"
                              : "Exact asset"}{" "}
                            · source preview
                          </small>
                        </span>
                      </label>
                    ))}
                  </div>
                ) : (
                  <p className="brand-empty-note">
                    Add a PNG or JPEG in Materials. Links alone are not visual
                    evidence for this analysis.
                  </p>
                )}
                {missingSelection && (
                  <p className="warning-note">
                    A selected source is no longer available.{" "}
                    <button
                      type="button"
                      className="text-button"
                      onClick={() =>
                        setMaterialIds((ids) =>
                          ids.filter((id) =>
                            rasters.some((item) => item.id === id),
                          ),
                        )
                      }
                    >
                      Remove unavailable selections
                    </button>
                  </p>
                )}
                <label className="analysis-guidance">
                  What should Kely look for? <span>optional</span>
                  <textarea
                    value={guidance}
                    maxLength={8000}
                    rows={3}
                    onChange={(event) => setGuidance(event.target.value)}
                    placeholder="Look at the type, contrast, pacing, and what makes these posts feel like us…"
                  />
                </label>
                <p className="brand-helper">
                  Review the selected images before starting.
                </p>
                <button
                  className="button primary"
                  disabled={
                    busy ||
                    !canEdit ||
                    !bundle ||
                    materialIds.length < 1 ||
                    materialIds.length > 3 ||
                    missingSelection
                  }
                >
                  Review analysis · 3 credits
                  <ArrowRight size={16} />
                </button>
              </fieldset>
            </form>
          ) : (
            <section
              className="analysis-detail"
              ref={detail}
              tabIndex={-1}
              aria-label="Selected analysis"
            >
              <div className="analysis-detail-heading">
                <h3>{statusLabels[selected.status]}</h3>
                <span className="brand-label">
                  Brand v{selected.brandVersion}
                  {selected.applied ? " · applied" : ""}
                </span>
              </div>
              <AnalysisOrigin analysis={selected} />
              <div className="analysis-exact-images">
                {selected.selected.map((material) => (
                  <figure key={material.id}>
                    <Image
                      src={
                        base +
                        "/" +
                        selected.id +
                        "/image?materialId=" +
                        encodeURIComponent(material.id)
                      }
                      alt={material.label + " — exact selected JPEG copy"}
                      width={material.width}
                      height={material.height}
                      unoptimized
                    />
                    <figcaption>
                      <strong>{material.label}</strong>
                      <span>
                        {material.role} · {material.width} × {material.height}{" "}
                        px
                      </span>
                      <details>
                        <summary>Exact analysis image</summary>
                        <p>
                          Private normalized JPEG. Transparency is white;
                          longest side is at most 1536 px.
                        </p>
                        <code>{material.derivativeHash}</code>
                      </details>
                    </figcaption>
                  </figure>
                ))}
              </div>
              {selected.guidance && (
                <details className="analysis-saved-guidance">
                  <summary>Your quoted guidance</summary>
                  <p dir="auto">{selected.guidance}</p>
                </details>
              )}
              {selected.status === "quoted" && (
                <div className="analysis-quote">
                  <div className="analysis-price">
                    <span>This exact analysis</span>
                    <strong>
                      {selected.credits} <small>credits</small>
                    </strong>
                  </div>
                  <p>
                    Study these images and propose a direction. You choose whether to save it.
                  </p>
                  <dl>
                    <div>
                      <dt>Available balance</dt>
                      <dd>{availableCredits} credits</dd>
                    </div>
                    <div>
                      <dt>Quote expires</dt>
                      <dd>{displayDate(selected.expiresAt)}</dd>
                    </div>
                  </dl>
                  {expired ? (
                    <p className="warning-note">
                      This quote expired. Create and review a new quote; nothing
                      starts automatically.
                    </p>
                  ) : budgetBlocked ? (
                    <p className="warning-note">
                      Analysis is temporarily unavailable. Your images are saved.
                    </p>
                  ) : availableCredits < selected.credits ? (
                    <>
                      <p className="warning-note">
                        More customer credits are needed. This analysis has not
                        started.
                      </p>
                      <button className="button primary" onClick={onBilling}>
                        View upgrade options
                        <ArrowRight size={15} />
                      </button>
                    </>
                  ) : (
                    <button
                      className="button primary"
                      disabled={busy || !canEdit}
                      onClick={() => void accept()}
                    >
                      Confirm analysis · {selected.credits} credits
                      <ArrowRight size={16} />
                    </button>
                  )}
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => open(null)}
                  >
                    Back to selection
                  </button>
                </div>
              )}
              {pending && (
                <div className="operation-notice" role="status">
                  <span className="activity-dot" />
                  <div>
                    <strong>
                      {selected.status === "queued"
                        ? "Waiting for the saved analysis to run"
                        : "Processing the quoted images"}
                    </strong>
                    <p>
                      {pollingPaused
                        ? "Status checking is paused. Refresh saved state to continue."
                        : "You can leave this section. Your result will be saved."}
                    </p>
                  </div>
                </div>
              )}
              {(selected.status === "failed" ||
                selected.status === "uncertain") && (
                <div className="warning-note" role="status">
                  <strong>
                    {selected.status === "uncertain"
                      ? "We’re checking the outcome."
                      : "Analysis couldn’t finish."}
                  </strong>
                  <p>
                    {selected.error ??
                      "The saved analysis outcome needs coordinator review."}
                  </p>
                  <p>Your sources are saved.</p>
                </div>
              )}
              {selected.status === "completed" && proposal && (
                <div className="analysis-proposal">
                  <span className="eyebrow">
                    YOUR PROPOSED STYLE
                  </span>
                  <h3>
                    {selected.origin === "openai"
                      ? "A direction to consider."
                      : "An example direction."}
                  </h3>
                  <p className="analysis-summary" dir="auto">
                    {proposal.summary}
                  </p>
                  <div className="analysis-observations">
                    <h4>
                      {selected.origin === "openai"
                        ? "Observed in your selected images"
                        : "Example observations"}
                    </h4>
                    {proposal.observations.map((item, index) => (
                      <article key={item.materialId + index}>
                        <strong>
                          {selected.selected.find(
                            (image) => image.id === item.materialId,
                          )?.label ?? "Unrecognized selected source"}
                        </strong>
                        <p dir="auto">{item.evidence}</p>
                        <span>
                          {item.purpose} · {item.confidence} confidence
                        </span>
                      </article>
                    ))}
                  </div>
                  {proposal.limitations.length > 0 && (
                    <div className="analysis-limitations">
                      <h4>Worth knowing</h4>
                      <ul>
                        {proposal.limitations.map((item, index) => (
                          <li key={index} dir="auto">
                            {item}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {proposal.missingOriginals.length > 0 && (
                    <div className="analysis-limitations">
                      <h4>Originals still needed</h4>
                      <ul>
                        {proposal.missingOriginals.map((item, index) => (
                          <li key={index} dir="auto">
                            {item}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <div className="analysis-proposed-direction">
                    <h4>Proposed visual direction</h4>
                    <DirectionSummary direction={proposal.direction} />
                    <div className="quote-role-colors">
                      {Object.entries(proposal.direction.palette).map(
                        ([role, color]) => (
                          <span key={role}>
                            <i
                              style={{
                                backgroundColor: /^#[a-f\d]{6}$/i.test(color)
                                  ? color
                                  : undefined,
                              }}
                              aria-hidden="true"
                            />
                            {role} {color}
                          </span>
                        ),
                      )}
                    </div>
                    <p>{proposal.fontNotice}</p>
                  </div>
                  {!safeReuse && (
                    <p className="warning-note">
                      A needed original is unavailable. Add it before applying this direction.
                    </p>
                  )}
                  {data.brand &&
                    data.brand.version !== selected.brandVersion &&
                    !selected.applied && (
                      <p className="warning-note">
                        Your brand has changed. Applying this replaces its current visual direction.
                      </p>
                    )}
                  {selected.applied ? (
                    <div className="analysis-applied" role="status">
                      <Check size={16} />
                      <p>
                        Direction saved for future posts.
                      </p>
                      {appliedEvent?.analysisId === selected.id && (
                        <button
                          className="text-button"
                          disabled={busy || !canEdit}
                          onClick={() => void undoApplied()}
                        >
                          Undo this direction
                        </button>
                      )}
                    </div>
                  ) : (
                    <>
                      <button
                        className="button primary"
                        disabled={busy || !canEdit || !data.brand || !safeReuse}
                        onClick={() => void apply()}
                      >
                        {selected.origin === "openai"
                          ? "Use this direction"
                          : "Use this example direction"}
                        <Check size={15} />
                      </button>
                      <p className="field-hint">
                        No extra credits. Earlier posts stay unchanged.
                      </p>
                    </>
                  )}
                </div>
              )}
              <CostDetails cost={selected.cost} />
            </section>
          )}
        </>
      )}
    </section>
  );
}
