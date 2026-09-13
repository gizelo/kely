"use client";

import { useEffect, useState } from "react";
import type { AnalysisView } from "../shared/analysis";
import type { SourceBundleView } from "../shared/brand";
import { displayDate, request, RequestError } from "./api";

export function AnalysisSourcePicker({
  value,
  onChange,
  busy,
  onError,
  onOpenBrand,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  busy: boolean;
  onError: (error: unknown) => void;
  onOpenBrand: () => void;
}) {
  const [analyses, setAnalyses] = useState<AnalysisView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [bundle, setBundle] = useState<SourceBundleView | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void request<SourceBundleView>(
      "/api/kely/brand/source-bundle",
      undefined,
      controller.signal,
    )
      .then((saved) => {
        if (!controller.signal.aborted) setBundle(saved);
      })
      .catch((failure: unknown) => {
        if (
          !controller.signal.aborted &&
          failure instanceof RequestError &&
          failure.status === 401
        )
          onError(failure);
      });
    void request<{ analyses: AnalysisView[] }>(
      "/api/kely/brand-analyses",
      undefined,
      controller.signal,
    )
      .then(({ analyses: saved }) => {
        if (!controller.signal.aborted)
          setAnalyses(
            saved.filter(
              (item) => item.status === "completed" && item.proposal,
            ),
          );
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          "Saved analysis is unavailable right now. You can still start with your idea.",
        );
        if (failure instanceof RequestError && failure.status === 401)
          onError(failure);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [onError]);
  const selected = analyses.find((item) => item.id === value);
  const missing = Boolean(value && !loading && !selected);
  return (
    <div className="new-post-source-context">
      <section className="brand-entry-card" aria-label="Brand context">
        <div>
          <strong>
          {bundle?.summary.learned.length
            ? "Your Brand is ready to reuse"
            : "Have a style or source Kely should use?"}
          </strong>
          <p>
            {bundle?.summary.learned.length
              ? `Kely will reuse: ${bundle.summary.learned.join(", ")}.`
              : "Add a link, screenshots, originals, or let Kely decide. You can still start with just your idea."}
          </p>
        </div>
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={onOpenBrand}
        >
          {bundle?.summary.learned.length ? "Review Brand" : "Add Brand context"}
        </button>
      </section>
      <details className="analysis-source-picker">
        <summary>
          Use a saved reference analysis{" "}
          <span>optional{value ? " · selected" : ""}</span>
        </summary>
        <label>
          Reference context for this post
          <select
            disabled={busy || loading}
            value={value ?? ""}
            onChange={(event) => onChange(event.target.value || null)}
          >
            <option value="">None — start with my idea and Brand</option>
            {missing && (
              <option value={value!}>
                Previously selected analysis unavailable
              </option>
            )}
            {analyses.map((item) => (
              <option key={item.id} value={item.id}>
                {item.origin === "openai" ? "OpenAI" : "Simulated"} ·{" "}
                {item.selected[0]?.label ?? "Selected references"} ·{" "}
                {displayDate(item.createdAt)}
              </option>
            ))}
          </select>
        </label>
        {loading ? (
          <p role="status">Loading saved analyses…</p>
        ) : error ? (
          <p className="warning-note">{error}</p>
        ) : analyses.length === 0 ? (
          <p>No completed analysis yet. It is not needed to start a post.</p>
        ) : (
          <p>
            Only this explicitly selected saved analysis is reused. No new
            analysis starts and no extra credit charge is added.
          </p>
        )}
        {missing && (
          <p className="warning-note">
            The selected analysis could not be loaded. Choose another completed
            analysis or None; your selection will not be silently replaced.
          </p>
        )}
        {selected?.proposal && (
          <div className="analysis-source-summary">
            <strong>
              {selected.origin === "openai"
                ? "Selected reference context"
                : "Simulated — no image analysis occurred"}
            </strong>
            <p dir="auto">{selected.proposal.summary}</p>
            <p>
              Observations are not verified facts or permission to reuse
              reference pixels.
            </p>
          </div>
        )}
      </details>
    </div>
  );
}
