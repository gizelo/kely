"use client";

import type { FrozenArtDirection } from "../shared/art-direction";
import type { DesignScene } from "../shared/design-scene";
import type {
  BriefField,
  CreativePlan,
  ProposedBrief,
  SelectedAnalysisContext,
} from "../shared/creative-intent";

const fieldLabels: Record<BriefField["basis"], string> = {
  user: "User statement",
  business: "Business context",
  proposed: "Proposed · please confirm",
};
const purposes: Record<CreativePlan["purpose"], string> = {
  hook: "Catch attention",
  explain: "Make the idea clear",
  proof: "Show the evidence",
  process: "Explain how it works",
  closing: "Leave a clear next step",
};
const recipes: Record<CreativePlan["recipe"], string> = {
  "type-poster": "Type-led poster",
  "graphic-stage": "Original graphic in focus",
  "split-proof": "Copy beside visual evidence",
  "image-evidence": "Image-led evidence",
  closing: "A focused closing frame",
};

export function designSceneDescription(
  scene: DesignScene,
  direction?: FrozenArtDirection,
) {
  const ideas: Record<DesignScene["composition"], string> = {
    "editorial-offset": scene.materialZone
      ? "Your original leads, with the headline and supporting copy below."
      : "A bold headline is balanced by simple shapes and open space.",
    "signal-grid": scene.materialZone
      ? "The headline and explanation introduce a wide view of your original."
      : "A small group of graphic shapes gives the message a clear visual rhythm.",
    "evidence-split":
      "The copy and your original sit side by side, so the image supports the message.",
    "structured-stack":
      "The headline, graphic accents, and explanation form an easy-to-follow sequence.",
    "action-frame":
      "A strong focal area keeps attention on the closing message and next step.",
  };
  const originalIndex =
    direction?.originals.findIndex(
      (item) => item.id === scene.materialZone?.id,
    ) ?? -1;
  const original =
    originalIndex >= 0
      ? `Saved original ${originalIndex + 1}`
      : "Selected original";
  return {
    idea: ideas[scene.composition],
    source: scene.materialZone
      ? `${original} with Kely-designed local graphic accents.`
      : "Kely-designed local artwork, composed deterministically—not AI-generated imagery.",
  };
}

function BriefValue({ label, field }: { label: string; field: BriefField }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <p dir="auto">{field.value}</p>
        <span className="brief-field-basis">{fieldLabels[field.basis]}</span>
      </dd>
    </div>
  );
}

export function CreativeBriefReview({
  brief,
  analysis,
  approved,
  canChange,
  onChange,
}: {
  brief: ProposedBrief;
  analysis?: SelectedAnalysisContext;
  approved: boolean;
  canChange: boolean;
  onChange: () => void;
}) {
  return (
    <details className="creative-brief-review" open={!approved}>
      <summary>
        {approved ? "Approved post brief" : "The idea we’re working toward"}
      </summary>
      <dl className="creative-brief-fields">
        <BriefValue label="For" field={brief.audience} />
        <BriefValue label="Next step" field={brief.desiredAction} />
      </dl>
      {brief.requiredFacts.length > 0 && (
        <div className="warning-note" role="status">
          <strong>Needed before content approval</strong>
          <ul>
            {brief.requiredFacts.map((fact, index) => (
              <li key={index} dir="auto">
                {fact}
              </li>
            ))}
          </ul>
          <p>
            Add the missing facts, or explain which claim to omit, in the
            conversation. Then review the next preparation reply.
          </p>
        </div>
      )}
      <details className="creative-brief-evidence">
        <summary>Facts &amp; source context</summary>
        {[brief.audience, brief.desiredAction, ...brief.facts].map(
          (field, index) => (
            <div key={index}>
              <p dir="auto">{field.value}</p>
              <span className="brief-field-basis">
                {fieldLabels[field.basis]}
              </span>
              {field.evidence && (
                <blockquote dir="auto">{field.evidence}</blockquote>
              )}
            </div>
          ),
        )}
        {analysis && (
          <div className="creative-analysis-context">
            <strong>
              {analysis.origin === "openai"
                ? "Selected OpenAI analysis"
                : "Selected simulated analysis · no image analysis occurred"}
            </strong>
            <p dir="auto">{analysis.summary}</p>
            {analysis.limitations.length > 0 && (
              <ul>
                {analysis.limitations.map((item, index) => (
                  <li key={index} dir="auto">
                    {item}
                  </li>
                ))}
              </ul>
            )}
            <p>
              Reference observations inform this post, not verified business
              facts or standing Brand consent.
            </p>
          </div>
        )}
      </details>
      {!approved && (
        <p className="creative-brief-next">
          Content approval confirms this brief and the slide plans too.{" "}
          <button
            className="text-button"
            disabled={!canChange}
            onClick={onChange}
          >
            Ask for a change
          </button>
        </p>
      )}
    </details>
  );
}

export function SlideCreativeSummary({
  plan,
  direction,
}: {
  plan: CreativePlan;
  direction?: FrozenArtDirection;
}) {
  if (plan.scene) {
    const description = designSceneDescription(plan.scene, direction);
    return (
      <div className="slide-creative-summary">
        <strong>{purposes[plan.purpose]}</strong>
        <p>{description.idea}</p>
        <p>{description.source}</p>
      </div>
    );
  }
  const originalIndex =
    direction?.originals.findIndex((item) => item.id === plan.materialId) ?? -1;
  return (
    <div className="slide-creative-summary">
      <strong>{purposes[plan.purpose]}</strong>
      <p>
        {recipes[plan.recipe]}
        {plan.materialId
          ? " · " +
            (originalIndex >= 0
              ? "Saved original " + (originalIndex + 1)
              : "Selected original")
          : " · No image"}
      </p>
      {plan.rationale && (
        <details>
          <summary>Why this slide</summary>
          <p dir="auto">{plan.rationale}</p>
        </details>
      )}
    </div>
  );
}
