"use client";

import { ArrowRight, Check, Palette, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { BrandView, PublicationBrief } from "../shared/brand";
import type { PublicationView } from "../shared/contracts";
import { request } from "./api";
import type { BrandData, RunBrandAction } from "./brand-data";
import { DirectionSummary } from "./art-direction-editor";
import {
  BrandCapabilities,
  BrandHistory,
  BrandMemory,
  paletteOptions,
} from "./brand-workspace";

function normalizedBrief(value?: PublicationBrief): PublicationBrief {
  return {
    audience: value?.audience ?? "",
    direction: value?.direction ?? null,
    requiredMaterialIds: value?.requiredMaterialIds ?? [],
    noPhoto: value?.noPhoto ?? false,
    blockingFacts: value?.blockingFacts ?? [],
    factResolution: value?.factResolution ?? "",
  };
}

export function PublicationBrandPanel({
  publication: p,
  busy,
  canEdit,
  run,
  data,
  onSave,
  onDirtyChange,
  onOpenBrand,
}: {
  publication: PublicationView;
  busy: boolean;
  canEdit: boolean;
  run: RunBrandAction;
  data: BrandData;
  onSave: (brief: PublicationBrief) => Promise<boolean>;
  onDirtyChange: (dirty: boolean) => void;
  onOpenBrand: () => void;
}) {
  const [draft, setDraft] = useState(() => normalizedBrief(p.brandBrief));
  const details = useRef<HTMLDetailsElement>(null);
  const photo = useRef<HTMLInputElement>(null);
  const saved = normalizedBrief(p.brandBrief);
  const savedSignature = JSON.stringify(saved);
  useEffect(
    () => setDraft(JSON.parse(savedSignature) as PublicationBrief),
    [savedSignature],
  );
  const pending = Boolean(p.pendingOperation);
  const composed = [
    "art-direction-v1",
    "creative-intent-v1",
    "creative-intent-v2",
    "creative-intent-v3",
    "creative-intent-v4",
    "creative-intent-v5",
    "creative-intent-v6",
    "creative-intent-v7",
    "creative-intent-v8",
  ].includes(p.designPolicy ?? "");
  const editable =
    canEdit &&
    !p.outlineApproved &&
    !p.preparation?.closed &&
    !pending &&
    ["collecting", "content_approval", "failed"].includes(p.status);
  const dirty = JSON.stringify(draft) !== savedSignature;
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  const originals =
    data.brand?.materials.filter(
      (material) => material.role === "original" && material.kind === "image",
    ) ?? [];
  const missingIds = draft.requiredMaterialIds.filter(
    (id) => !originals.some((item) => item.id === id),
  );
  const resolvingFacts =
    draft.blockingFacts.length > 0 &&
    draft.factResolution.trim().length > 0 &&
    draft.factResolution.trim() !== saved.factResolution.trim();

  function update<K extends keyof PublicationBrief>(
    field: K,
    value: PublicationBrief[K],
  ) {
    setDraft((current) => ({ ...current, [field]: value }));
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!editable || busy) return;
    const next = {
      ...draft,
      audience: draft.audience.trim(),
      factResolution: draft.factResolution.trim(),
      blockingFacts: resolvingFacts ? [] : draft.blockingFacts,
    };
    if (await onSave(next)) setDraft(next);
  }
  function chooseMaterial(id: string, checked: boolean) {
    update(
      "requiredMaterialIds",
      checked
        ? [...draft.requiredMaterialIds, id]
        : draft.requiredMaterialIds.filter((item) => item !== id),
    );
  }
  function prepareNoPhoto() {
    update("noPhoto", true);
    if (details.current) details.current.open = true;
    photo.current?.focus();
  }
  function undo(eventId: string) {
    void data.change(() =>
      request<BrandView>("/api/kely/brand/undo", {
        eventId,
        commandKey: data.commandKey("undo", { eventId }),
      }),
    );
  }

  return (
    <section
      className="publication-brand-panel"
      aria-label="Brand and current post brief"
    >
      <details
        ref={details}
        className="post-brief-details"
        open={dirty || (!p.outlineApproved && draft.blockingFacts.length > 0)}
      >
        <summary>
          <span>
            <Palette size={16} />
            <strong>This post’s details</strong>
          </span>
          <span>
            {dirty
              ? "Unsaved changes"
              : p.outlineApproved
                ? "Locked after content approval"
                : p.readiness?.ready
                  ? "Ready for the approval steps"
                  : p.readiness?.blockers.length
                    ? `${p.readiness.blockers.length} details to confirm before approval`
                    : "Context, direction, and materials"}
          </span>
        </summary>
        <div className="post-brief-content">
          <p className="brand-helper">
            Audience and creative direction help us make a useful post. Brand
            gives you a starting point; these choices belong only to this post.
          </p>
          {p.readiness && !p.readiness.ready && (
            <div className="brand-readiness" role="status">
              <strong>
                A little more is needed before content approval and visuals.
              </strong>
              <ul>
                {p.readiness.blockers.map((blocker, index) => (
                  <li key={blocker.code + index}>{blocker.message}</li>
                ))}
              </ul>
              <p>Nothing is generated or charged by saving this brief.</p>
            </div>
          )}
          {!editable && (
            <p className="brand-helper">
              {p.outlineApproved
                ? "This brief is locked. Saved brand changes apply to future work, not this approved post."
                : pending
                  ? "The current operation must finish before the brief can change."
                  : "This draft’s brief is read-only right now."}
            </p>
          )}
          <form onSubmit={submit} className="post-brief-form">
            <fieldset disabled={busy || !editable}>
              <div className="post-brief-fields">
                <label>
                  Who is this post for?
                  <textarea
                    rows={2}
                    maxLength={500}
                    value={draft.audience}
                    onChange={(event) => update("audience", event.target.value)}
                    placeholder="A short audience description is enough…"
                  />
                </label>
                <label>
                  Creative direction
                  <select
                    value={
                      composed
                        ? draft.direction
                          ? "decide"
                          : ""
                        : (draft.direction ?? "")
                    }
                    onChange={(event) =>
                      update(
                        "direction",
                        (event.target.value ||
                          null) as PublicationBrief["direction"],
                      )
                    }
                  >
                    <option value="">Choose when you’re ready</option>
                    <option value="decide">
                      {composed ? "Use saved Brand direction" : "Decide for me"}
                    </option>
                    {!composed &&
                      paletteOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                  </select>
                  <small>
                    {composed
                      ? "Uses the saved Brand direction when preparation begins. Prepared posts keep their pinned colors and original selection."
                      : "“Decide for me” uses your standing palette, or Indigo if none is saved. The quote discloses the selected palette."}
                  </small>
                </label>
              </div>
              {data.brand?.rules.audience &&
                draft.audience !== data.brand.rules.audience && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() =>
                      update("audience", data.brand!.rules.audience)
                    }
                  >
                    Use saved brand audience
                  </button>
                )}
              <label className="post-photo-rule">
                <input
                  ref={photo}
                  type="checkbox"
                  checked={draft.noPhoto}
                  onChange={(event) => update("noPhoto", event.target.checked)}
                />
                No photo in this post
              </label>
              <p className="brand-helper">
                {composed
                  ? "A post-only preference. A direction with imagery will be blocked, not silently stripped; an original logo may remain."
                  : "A post-only preference, never a standing rule. This older post uses the typography-only renderer."}
              </p>
              {(draft.blockingFacts.length > 0 || draft.factResolution) && (
                <label className="post-fact-resolution">
                  Facts or claims to omit
                  <textarea
                    rows={3}
                    maxLength={1000}
                    value={draft.factResolution}
                    onChange={(event) =>
                      update("factResolution", event.target.value)
                    }
                    placeholder="Provide the confirmed facts, or explain which unsupported claim this post should omit."
                  />
                  <small>
                    {resolvingFacts
                      ? "Saving records this resolution and reopens preparation. Current copy must be prepared and approved again."
                      : "Only an explicit saved explanation can resolve a factual blocker. It is recorded as your statement, not independently verified."}
                  </small>
                </label>
              )}
              <details className="post-required-materials">
                <summary>Does this post require an original material?</summary>
                <p className="warning-note">
                  {composed
                    ? "Only mark an original required if this post cannot omit it. It must also be selected in the saved visual direction; uploading it alone does not place it. References cannot stand in for originals."
                    : "Only mark a material required if this post cannot omit it. This older post cannot place originals, so a required original blocks visual work. Ordinary inspiration does not need to be required."}
                </p>
                {data.loading ? (
                  <p className="brand-helper">Loading saved originals…</p>
                ) : originals.length ? (
                  originals.map((material) => (
                    <label key={material.id}>
                      <input
                        type="checkbox"
                        checked={draft.requiredMaterialIds.includes(
                          material.id,
                        )}
                        onChange={(event) =>
                          chooseMaterial(material.id, event.target.checked)
                        }
                      />
                      <span>
                        {material.label}
                        <small>
                          Original · v{material.version} ·{" "}
                          {composed
                            ? "must be selected in the visual direction"
                            : "not placed in this older post"}
                        </small>
                      </span>
                    </label>
                  ))
                ) : (
                  <p className="brand-helper">
                    No active original raster images. You can add them in Brand;
                    you don’t need one for a typography-only post.
                  </p>
                )}
                {missingIds.map((id) => (
                  <label key={id}>
                    <input
                      type="checkbox"
                      checked
                      onChange={() => chooseMaterial(id, false)}
                    />
                    <span>
                      Required material is unavailable
                      <small>
                        Remove only if this post can genuinely omit it.
                      </small>
                    </span>
                  </label>
                ))}
              </details>
              {dirty && (
                <p className="brand-unsaved" role="status">
                  Save your brief before requesting a quote or approving
                  content.
                </p>
              )}
              <button
                className="button secondary"
                disabled={
                  busy || !editable || (!dirty && Boolean(p.brandBrief))
                }
              >
                {resolvingFacts
                  ? "Save facts & reopen preparation"
                  : "Save this post’s brief"}
                <Check size={15} />
              </button>
            </fieldset>
          </form>
          <div className="post-brand-footer">
            {p.artDirection && (
              <div className="post-pinned-direction">
                <strong>Prepared direction · pinned to this post</strong>
                <DirectionSummary direction={p.artDirection.direction} />
              </div>
            )}
            <span>
              {data.brand
                ? `Brand settings v${data.brand.version} · accepted work stays pinned`
                : "Brand settings are not loaded"}
            </span>
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await data.reload();
                })
              }
            >
              <RefreshCw size={13} />
              Refresh Brand
            </button>
            <button type="button" className="text-button" onClick={onOpenBrand}>
              Brand settings & materials
              <ArrowRight size={14} />
            </button>
          </div>
          <BrandCapabilities compact />
        </div>
      </details>
      <details className="post-standing-memory">
        <summary>Want Kely to remember something for future posts?</summary>
        <p className="brand-helper">
          Standing preferences belong in Brand, even when you’re working on this
          post. Existing copy and visuals stay unchanged.
        </p>
        {data.brand ? (
          <>
            <BrandMemory
              busy={busy || !canEdit}
              onRemember={data.remember}
              onLocal={editable ? prepareNoPhoto : undefined}
            />
            <BrandHistory
              brand={data.brand}
              busy={busy || !canEdit}
              onUndo={undo}
            />
          </>
        ) : (
          <button
            className="text-button"
            disabled={busy || data.loading}
            onClick={() =>
              void run(async () => {
                await data.reload();
              })
            }
          >
            Load Brand preferences
          </button>
        )}
      </details>
    </section>
  );
}
