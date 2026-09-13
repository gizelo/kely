"use client";

import { useState } from "react";
import type { BrandView } from "../shared/brand";
import type { PublicationView } from "../shared/contracts";
import type { BrandData } from "./brand-data";

export interface PreferenceConfirmation {
  proposalId: string;
  scope: "durable" | "local";
  version: number;
  brandVersion: number;
  commandKey: string;
}

export function PreferenceSuggestions({
  publication: p,
  data,
  disabled,
  onConfirm,
}: {
  publication: PublicationView;
  data: BrandData;
  disabled: boolean;
  onConfirm: (input: PreferenceConfirmation) => Promise<BrandView>;
}) {
  const [dismissed, setDismissed] = useState<string[]>([]);
  const proposals = (p.preferenceProposals ?? []).filter(
    (proposal) =>
      proposal.scope !== "local" &&
      !dismissed.includes(proposal.id) &&
      p.messages.some(
        (message) =>
          message.role === "user" &&
          message.id === proposal.messageId &&
          message.text.includes(proposal.evidence),
      ),
  );
  const locals = Object.entries(p.localPreferences ?? {}).filter(([, value]) =>
    Boolean(value),
  );
  const completed = p.creation?.status === "ready" || p.outlineApproved || Boolean(p.preparation?.closed);
  if (!proposals.length && !locals.length) return null;

  function confirm(proposalId: string, scope: "durable" | "local") {
    if (!data.brand || disabled) return;
    const input = {
      proposalId,
      scope,
      version: p.version,
      brandVersion: data.brand.version,
    };
    void data.change(() =>
      onConfirm({
        ...input,
        commandKey: data.commandKey("preference:" + p.id, input),
      }),
    );
  }

  return (
    <section
      className="preference-suggestions"
      aria-label="Preferences from your feedback"
    >
      {proposals.map((proposal) => (
        <article className="preference-suggestion" key={proposal.id}>
          <span className="small-label">KELY · A PREFERENCE TO CONFIRM</span>
          <h3>
            {completed
              ? "Remember this for future posts?"
              : proposal.scope === "ambiguous"
              ? "Just this post, or future posts too?"
              : "Would you like me to remember this?"}
          </h3>
          <p>From your message:</p>
          <blockquote dir="auto">{proposal.evidence}</blockquote>
          <p className="preference-value" dir="auto">
            <strong>
              {proposal.field === "headlines"
                ? "Headlines"
                : proposal.field === "voice"
                  ? "Voice"
                  : "Audience"}
              :
            </strong>{" "}
            {proposal.field === "headlines" && proposal.value === "shorter"
              ? "Prefer shorter headlines"
              : proposal.value}
          </p>
          {proposal.reason && (
            <details>
              <summary>Why this suggestion?</summary>
              <p>{proposal.reason}</p>
            </details>
          )}
          <p className="brand-helper">
            {completed
              ? "Nothing is remembered yet. Confirming is free and saves the preference for future posts without changing this finished post."
              : "Nothing is remembered yet. Confirming is free, saves the preference, and reopens copy preparation."}
          </p>
          <div className="preference-actions">
            <button
              type="button"
              className="button secondary"
              disabled={disabled || !data.brand}
              onClick={() => confirm(proposal.id, "durable")}
            >
              Remember for future posts
            </button>
            {!completed && <button
              type="button"
              className="button secondary"
              disabled={disabled || !data.brand}
              onClick={() => confirm(proposal.id, "local")}
            >
              Only this post
            </button>}
            <button
              type="button"
              className="text-button"
              disabled={disabled}
              onClick={() => setDismissed((items) => [...items, proposal.id])}
            >
              Dismiss
            </button>
          </div>
          {!data.brand && (
            <p className="brand-helper">
              Brand rules must load before you can confirm.
            </p>
          )}
        </article>
      ))}
      {locals.length > 0 && (
        <details className="post-local-preferences">
          <summary>Confirmed for this post only</summary>
          <dl>
            {locals.map(([field, value]) => (
              <div key={field}>
                <dt>{field}</dt>
                <dd dir="auto">{value}</dd>
              </div>
            ))}
          </dl>
          <p>These preferences do not carry into another post.</p>
        </details>
      )}
    </section>
  );
}
