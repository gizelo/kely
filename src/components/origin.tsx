import type { CostEvidence, GenerationOrigin } from "../shared/contracts";

export function originLabel(origin: GenerationOrigin = "fixture") {
  return origin === "openai"
    ? "AI-generated"
    : "Example";
}

export function originExplanation(origin: GenerationOrigin = "fixture") {
  return origin === "openai"
    ? "Created with AI and Kely’s design tools."
    : origin === "ai_preview"
      ? "Simulated responses test the workflow. No real AI request or quality evidence."
      : "A deterministic fixture example, not AI-generated quality evidence.";
}

export function OriginBadge({
  origin,
  visual,
}: {
  origin?: GenerationOrigin;
  visual?: "fixture" | "deterministic";
}) {
  if (origin === "openai" && visual !== "fixture") return null;
  return (
    <span
      className={"origin-badge origin-" + (origin ?? "fixture")}
      title={originExplanation(origin)}
    >
      Example
    </span>
  );
}

export function CostDetails({ cost }: { cost?: CostEvidence }) {
  if (!cost) return null;
  const maximumRetained = cost.basis === "maximum_reserved";
  const dollars = (micros: number) =>
    new Intl.NumberFormat("en", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 4,
      maximumFractionDigits: 6,
    }).format(micros / 1_000_000);
  return (
    <details className="cost-evidence">
      <summary>
        {cost.simulated ? "Example cost details" : "Cost details"}
      </summary>
      <dl>
        <div>
          <dt>Model</dt>
          <dd>{cost.model}</dd>
        </div>
        <div>
          <dt>
            {cost.basis === "usage_rated"
              ? "Usage-rated amount"
              : maximumRetained
                ? "Settled accounting amount"
                : "Bounded settled amount"}
          </dt>
          <dd>{dollars(cost.settledMicros)}</dd>
        </div>
        <div>
          <dt>
            {maximumRetained
              ? "Retained maximum exposure"
              : "Unresolved exposure"}
          </dt>
          <dd>{dollars(cost.uncertainMicros)}</dd>
        </div>
      </dl>
      {maximumRetained && (
        <p>
          Usage is unverified. The maximum reserved liability remains held until
          reconciliation; it is not confirmed usage or a final charge.
        </p>
      )}
      <p>
        {cost.simulated
          ? "Test accounting only; no real provider spend."
          : "Application accounting, not a confirmed provider invoice."}
      </p>
    </details>
  );
}
