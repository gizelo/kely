"use client";

import Image from "next/image";
import { Check, ArrowRight } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import type { ArtDirection } from "../shared/art-direction";
import type { BrandView } from "../shared/brand";

const starter: ArtDirection = {
  policy: "art-direction-v1",
  palette: {
    background: "#F8F7F3",
    foreground: "#17181C",
    accent: "#254BFF",
    muted: "#62646B",
  },
  headingFont: "sans",
  composition: "editorial",
  spacing: "open",
  logoMaterialId: null,
  heroMaterialIds: [],
};
const colorRoles = [
  { key: "background", label: "Background" },
  { key: "foreground", label: "Main text" },
  { key: "accent", label: "Accent" },
  { key: "muted", label: "Secondary detail" },
] as const;
const isHex = (value: string) => /^#[a-f\d]{6}$/i.test(value);

function textContrast(background: string, foreground: string) {
  if (!isHex(background) || !isHex(foreground)) return null;
  const luminance = (color: string) => {
    const [r, g, b] = [1, 3, 5]
      .map((offset) => parseInt(color.slice(offset, offset + 2), 16) / 255)
      .map((value) =>
        value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
      );
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const values = [luminance(background), luminance(foreground)].sort(
    (a, b) => b - a,
  );
  return (values[0] + 0.05) / (values[1] + 0.05);
}

export function DirectionSummary({ direction }: { direction: ArtDirection }) {
  return (
    <span className="direction-summary">
      {direction.composition === "image-led"
        ? "Image-led"
        : direction.composition === "split"
          ? "Split"
          : "Editorial"}{" "}
      ·{" "}
      {direction.headingFont === "unbounded"
        ? "Unbounded"
        : direction.headingFont === "serif"
          ? "Serif"
          : "Sans serif"}{" "}
      · {direction.spacing === "open" ? "Open spacing" : "Compact spacing"}
      {direction.logoMaterialId ? " · original logo" : ""}
      {direction.heroMaterialIds.length
        ? ` · ${direction.heroMaterialIds.length} original image${direction.heroMaterialIds.length > 1 ? "s" : ""}`
        : " · no imagery"}
    </span>
  );
}

export function ArtDirectionEditor({
  brand,
  busy,
  onSave,
  onMaterials,
}: {
  brand: BrandView;
  busy: boolean;
  onSave: (direction: ArtDirection | null) => Promise<boolean>;
  onMaterials: () => void;
}) {
  const signature = JSON.stringify(brand.rules.artDirection ?? null);
  const [draft, setDraft] = useState<ArtDirection>(() =>
    structuredClone(brand.rules.artDirection ?? starter),
  );
  useEffect(
    () => setDraft(JSON.parse(signature) ?? structuredClone(starter)),
    [signature],
  );
  const originals = brand.materials.filter(
    (item) => item.kind === "image" && item.role === "original",
  );
  const selectedIds = [
    ...draft.heroMaterialIds,
    ...(draft.logoMaterialId ? [draft.logoMaterialId] : []),
  ];
  const missing = selectedIds.filter(
    (id) => !originals.some((item) => item.id === id),
  );
  const duplicate = new Set(selectedIds).size !== selectedIds.length;
  const validColors = colorRoles.every(({ key }) => isHex(draft.palette[key]));
  const contrast = textContrast(
    draft.palette.background,
    draft.palette.foreground,
  );
  const needsImage =
    draft.composition !== "editorial" && draft.heroMaterialIds.length === 0;
  const dirty = JSON.stringify(draft) !== signature;
  const valid =
    validColors &&
    contrast !== null &&
    contrast >= 4.5 &&
    !needsImage &&
    !missing.length &&
    !duplicate;

  function update<K extends keyof ArtDirection>(
    field: K,
    value: ArtDirection[K],
  ) {
    setDraft((current) => ({ ...current, [field]: value }));
  }
  function color(role: keyof ArtDirection["palette"], value: string) {
    setDraft((current) => ({
      ...current,
      palette: { ...current.palette, [role]: value },
    }));
  }
  function imagery(id: string, checked: boolean) {
    update(
      "heroMaterialIds",
      checked
        ? [...draft.heroMaterialIds, id]
        : draft.heroMaterialIds.filter((value) => value !== id),
    );
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid || busy) return;
    const palette = { ...draft.palette };
    for (const { key } of colorRoles) palette[key] = palette[key].toUpperCase();
    await onSave({ ...draft, palette });
  }

  return (
    <details
      className="art-direction-editor"
      open={Boolean(brand.rules.artDirection)}
    >
      <summary>
        <strong>Your visual direction</strong>
        <span>
          {brand.rules.artDirection ? (
            <DirectionSummary direction={brand.rules.artDirection} />
          ) : (
            "Choose a look, then make it yours"
          )}
        </span>
      </summary>
      <div className="art-direction-content">
        <p className="brand-helper">
          Save a direction for newly prepared posts. Your selected originals are
          composed without recreating their identity. Existing prepared posts
          and accepted work keep their saved direction.
        </p>
        {!brand.rules.artDirection && (
          <p className="brand-helper">
            These are editable starting values, not an analyzed or saved brand
            style.
          </p>
        )}
        <form onSubmit={submit}>
          <fieldset disabled={busy}>
            <div className="direction-core-fields">
              <label>
                Composition
                <select
                  value={draft.composition}
                  onChange={(event) =>
                    update(
                      "composition",
                      event.target.value as ArtDirection["composition"],
                    )
                  }
                >
                  <option value="editorial">Editorial — words first</option>
                  <option value="split">Split — words and imagery</option>
                  <option value="image-led">
                    Image-led — the original takes the lead
                  </option>
                </select>
              </label>
              <label>
                Headline type
                <select
                  value={draft.headingFont}
                  onChange={(event) =>
                    update(
                      "headingFont",
                      event.target.value as ArtDirection["headingFont"],
                    )
                  }
                >
                  <option value="sans">Sans serif — clean and direct</option>
                  <option value="serif">
                    Serif — expressive and editorial
                  </option>
                  <option value="unbounded">
                    Unbounded — bold and expansive
                  </option>
                </select>
              </label>
            </div>
            <div
              className="direction-palette"
              aria-label="Custom palette roles"
            >
              {colorRoles.map(({ key, label }) => (
                <div key={key}>
                  <span>{label}</span>
                  <div>
                    <input
                      type="color"
                      value={
                        isHex(draft.palette[key])
                          ? draft.palette[key]
                          : "#000000"
                      }
                      onChange={(event) => color(key, event.target.value)}
                      aria-label={`${label} color picker`}
                    />
                    <input
                      type="text"
                      value={draft.palette[key]}
                      onChange={(event) => color(key, event.target.value)}
                      maxLength={7}
                      pattern="#[a-fA-F0-9]{6}"
                      required
                      spellCheck={false}
                      autoComplete="off"
                      aria-label={`${label} hex color`}
                    />
                  </div>
                </div>
              ))}
            </div>
            <p
              className={
                "direction-contrast " +
                (contrast !== null && contrast >= 4.5
                  ? "contrast-good"
                  : "contrast-needs-work")
              }
              role="status"
            >
              {contrast === null
                ? "Use six-digit hex colors such as #254BFF."
                : `Text contrast ${contrast.toFixed(2)}:1 · ${contrast >= 4.5 ? "meets the 4.5:1 minimum" : "needs at least 4.5:1 before saving"}`}
            </p>
            <div className="direction-originals">
              <div className="brand-section-heading">
                <div>
                  <h3>Bring your originals.</h3>
                  <p>
                    A real logo, product screenshot or photograph. References
                    and links are not reusable originals.
                  </p>
                </div>
                <button
                  type="button"
                  className="text-button"
                  onClick={onMaterials}
                >
                  Add materials
                  <ArrowRight size={14} />
                </button>
              </div>
              <label>
                Original logo
                <select
                  value={draft.logoMaterialId ?? ""}
                  onChange={(event) =>
                    update("logoMaterialId", event.target.value || null)
                  }
                >
                  <option value="">No logo</option>
                  {originals.map((item) => (
                    <option
                      key={item.id}
                      value={item.id}
                      disabled={draft.heroMaterialIds.includes(item.id)}
                    >
                      {item.label}
                    </option>
                  ))}
                  {draft.logoMaterialId &&
                    missing.includes(draft.logoMaterialId) && (
                      <option value={draft.logoMaterialId}>
                        Unavailable original — choose another or no logo
                      </option>
                    )}
                </select>
              </label>
              <span className="direction-field-label">
                Original imagery · up to two
              </span>
              {originals.length ? (
                <div className="direction-original-grid">
                  {originals.map((item) => (
                    <label
                      key={item.id}
                      className={
                        draft.heroMaterialIds.includes(item.id)
                          ? "selected"
                          : ""
                      }
                    >
                      <input
                        type="checkbox"
                        checked={draft.heroMaterialIds.includes(item.id)}
                        disabled={
                          busy ||
                          item.id === draft.logoMaterialId ||
                          (!draft.heroMaterialIds.includes(item.id) &&
                            draft.heroMaterialIds.length >= 2)
                        }
                        onChange={(event) =>
                          imagery(item.id, event.target.checked)
                        }
                      />
                      <Image
                        src={
                          "/api/kely/brand-materials/" +
                          encodeURIComponent(item.id)
                        }
                        alt=""
                        width={item.width ?? 100}
                        height={item.height ?? 100}
                        unoptimized
                      />
                      <span>
                        {item.label}
                        <small>
                          {item.id === draft.logoMaterialId
                            ? "Selected as logo"
                            : `Original · v${item.version}`}
                        </small>
                      </span>
                    </label>
                  ))}
                </div>
              ) : (
                <p className="brand-empty-note">
                  No original images yet. Editorial works with text alone. Add
                  an original in Materials when you want a logo or imagery.
                </p>
              )}
              {missing
                .filter((id) => draft.heroMaterialIds.includes(id))
                .map((id) => (
                  <label className="direction-missing-original" key={id}>
                    <input
                      type="checkbox"
                      checked
                      onChange={() => imagery(id, false)}
                    />
                    Selected original is unavailable. Uncheck to remove it.
                  </label>
                ))}
              {needsImage && (
                <p className="warning-note">
                  This composition needs an original image. Select one above, or
                  choose Editorial for a typography-only direction.
                </p>
              )}
              {duplicate && (
                <p className="warning-note">
                  Use different originals for the logo and the main imagery.
                </p>
              )}
              <p className="brand-helper">
                A post marked “No photo” cannot use a direction with imagery.
                The original logo may remain; nothing is silently removed.
              </p>
            </div>
            <details className="direction-advanced">
              <summary>Spacing & preview details</summary>
              <label>
                Spacing
                <select
                  value={draft.spacing}
                  onChange={(event) =>
                    update(
                      "spacing",
                      event.target.value as ArtDirection["spacing"],
                    )
                  }
                >
                  <option value="open">Open — more breathing room</option>
                  <option value="compact">Compact — a denser rhythm</option>
                </select>
              </label>
              <p className="brand-helper">
                Fonts use the supported local families. The controls describe a
                direction, not a rendered post preview. Exact placement and copy
                fit are checked when your post is composed. Reference analysis
                is a separate quoted action; font uploads are not connected.
              </p>
            </details>
            <div className="direction-save">
              <button
                className="button primary"
                disabled={busy || !dirty || !valid}
              >
                Save visual direction
                <Check size={15} />
              </button>
              {dirty && (
                <span>Not saved yet · no generation or credit charge</span>
              )}
            </div>
          </fieldset>
        </form>
        {brand.rules.artDirection && (
          <button
            type="button"
            className="text-button direction-clear"
            disabled={busy}
            onClick={() => void onSave(null)}
          >
            Clear custom direction; use the standing palette fallback
          </button>
        )}
        <p className="brand-helper direction-undo-note">
          Every saved change appears in preference history with Undo. Other
          preferences stay intact.
        </p>
      </div>
    </details>
  );
}
