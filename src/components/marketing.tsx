"use client";

import {
  ArrowRight,
  Check,
  Lightbulb,
  Info,
  Mail,
  Sparkles,
} from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import type { AccountView, Cadence, Platform } from "../shared/contracts";
import { displayDate } from "./api";
import { KelyLogo } from "./identity";

export interface Draft {
  idea: string;
  platform: Platform;
  slideCount: number;
}

export function Brand({ onClick }: { onClick: () => void }) {
  return (
    <button className="brand" onClick={onClick} aria-label="Kely home">
      <KelyLogo />
    </button>
  );
}

export function IdeaForm({
  draft,
  onChange,
  onSubmit,
  busy,
  compact = false,
  additionalContext,
}: {
  draft: Draft;
  onChange: (value: Draft) => void;
  onSubmit: () => void;
  busy: boolean;
  compact?: boolean;
  additionalContext?: ReactNode;
}) {
  return (
    <form
      className={`idea-form ${compact ? "compact" : ""}`}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <label className="sr-only" htmlFor="post-idea">
        Your post idea
      </label>
      <span className="idea-label">Your post idea</span>
      <textarea
        id="post-idea"
        value={draft.idea}
        onChange={(event) => onChange({ ...draft, idea: event.target.value })}
        placeholder="We’re opening a new coffee shop. I want to introduce it…"
        maxLength={2000}
        rows={compact ? 4 : 3}
        required
      />
      {additionalContext}
      <div className="idea-controls">
        <div className="idea-options">
          <label>
            <span className="sr-only">Social platform</span>
            <select
              aria-label="Social platform"
              value={draft.platform}
              onChange={(event) =>
                onChange({ ...draft, platform: event.target.value as Platform })
              }
            >
              <option value="linkedin">LinkedIn post</option>
              <option value="instagram">Instagram post</option>
            </select>
          </label>
          <details className="format-options">
            <summary>{draft.slideCount === 0 ? "Format · Kely’s choice" : draft.slideCount === 1 ? "Single image" : `${draft.slideCount} slides`}</summary>
          <label>
            <span className="sr-only">Post length</span>
            <select
              aria-label="Post length"
              value={draft.slideCount}
              onChange={(event) =>
                onChange({ ...draft, slideCount: Number(event.target.value) })
              }
            >
              <option value={0}>Let Kely suggest a format</option>
              <option value={1}>Single image</option>
              {[2, 3, 4, 5, 6].map((count) => (
                <option key={count} value={count}>
                  {`${count}-slide carousel`}
                </option>
              ))}
            </select>
          </label>
          </details>
        </div>
        <button
          className="button primary"
          disabled={busy || !draft.idea.trim()}
        >
          {busy
            ? "Opening…"
            : compact
              ? "Start this post"
              : "Make my post"}
          <ArrowRight size={17} aria-hidden="true" />
        </button>
      </div>
      <button
        className="idea-help"
        type="button"
        disabled={busy}
        onClick={() =>
          onChange({
            ...draft,
            idea: "Help me find a post idea for my business.",
          })
        }
      >
        <Lightbulb size={16} aria-hidden="true" />
        Help me find an idea
      </button>
    </form>
  );
}

export function Examples({ small = false }: { small?: boolean }) {
  return (
    <section
      className={`examples ${small ? "examples-small" : ""}`}
      aria-label="Examples"
    >
      <div className="section-eyebrow">CONCEPT EXAMPLES</div>
      {!small && (
        <h2>
          Your business. <em>Your style.</em>
        </h2>
      )}
      <div className="example-grid">
        <article className="example-card example-output">
          <img
            src="/examples/girex-product.png"
            alt="Dark Girex product carousel cover with a product screenshot and bold headline"
          />
          <span className="example-bottom">Product spotlight</span>
        </article>
        <article className="example-card example-output">
          <img
            src="/examples/bakery-neighborhood.png"
            alt="German bakery carousel slide on a dark background with an invitation and address"
          />
          <span className="example-bottom">Meet the neighborhood</span>
        </article>
        <article className="example-card example-output">
          <img
            src="/examples/bakery-opening.png"
            alt="German bakery carousel closing slide with opening time and address"
          />
          <span className="example-bottom">Opening day</span>
        </article>
      </div>
    </section>
  );
}

export function Landing({
  draft,
  onChange,
  onStart,
  onSignIn,
  onCreateAccount,
  busy,
}: {
  draft: Draft;
  onChange: (draft: Draft) => void;
  onStart: () => void;
  onSignIn: () => void;
  onCreateAccount: () => void;
  busy: boolean;
}) {
  return (
    <>
      <header className="site-header">
        <Brand
          onClick={() => window.scrollTo({ top: 0, behavior: "instant" })}
        />
        <nav aria-label="Main navigation">
          <a href="#examples">Examples</a>
          <a href="/beta-info">Privacy</a>
          <button className="button quiet" onClick={onSignIn}>
            Log in
            <ArrowRight size={15} aria-hidden="true" />
          </button>
        </nav>
      </header>
      <main id="main-content" className="landing-main" tabIndex={-1}>
        <section className="hero">
          <span className="eyebrow">YOUR AI DESIGNER</span>
          <h1>
            Your next post.
            <br />
            <em>Already on brand.</em>
          </h1>
          <p className="hero-description">
            Your ideas, shaped into social posts that feel like your business.
          </p>
          <IdeaForm
            draft={draft}
            onChange={onChange}
            onSubmit={onStart}
            busy={busy}
          />
          <p className="hero-footnote">
            For LinkedIn & Instagram · Start with an idea
          </p>
        </section>
        <div id="examples">
          <Examples />
        </div>
        <section className="how-it-works">
          <div>
            <span className="step-number">01</span>
            <h3>Bring a thought</h3>
            <p>
              An announcement, a question, or just “I don’t know what to post.”
            </p>
          </div>
          <div>
            <span className="step-number">02</span>
            <h3>Shape the plan</h3>
            <p>Bring your style. Discuss the text and direction before you generate.</p>
          </div>
          <div>
            <span className="step-number">03</span>
            <h3>Make it yours</h3>
            <p>Ask for changes in a message. Download when you’re happy.</p>
          </div>
        </section>
        <section className="landing-price-preview" aria-labelledby="landing-plans-title">
          <div>
            <span className="eyebrow">START SIMPLY</span>
            <h2 id="landing-plans-title">Create your Kely workspace.</h2>
            <p>Save your ideas and brand materials. Creative plans become available with an active allowance.</p>
          </div>
          <button className="text-button" onClick={onCreateAccount}>Create an account<ArrowRight size={16} /></button>
        </section>
      </main>
      <footer className="site-footer">
        <KelyLogo small />
        <span>Your ideas. Beautifully made.</span>
      </footer>
    </>
  );
}

export function PublicLanding() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [message, setMessage] = useState("");

  async function joinWaitlist(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!email.trim() || status === "sending") return;
    setStatus("sending");
    setMessage("");
    try {
      const response = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), consent: true, source: "landing" }),
      });
      const value = await response.json().catch(() => null);
      if (!response.ok) throw new Error(value?.error?.message ?? "We couldn’t save your email. Try again.");
      setStatus("done");
      setMessage("You’re on the list. We’ll only email you about Kely access.");
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "We couldn’t save your email. Try again.");
    }
  }

  return <div className="public-landing">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <header className="public-header">
      <KelyLogo />
      <a className="button secondary" href="#waitlist">Join the waitlist</a>
    </header>
    <main id="main-content" tabIndex={-1}>
      <section className="public-hero">
        <div className="public-hero-copy">
          <span className="public-kicker"><Sparkles size={16} aria-hidden="true" />Your AI designer</span>
          <h1>On-brand social posts, <em>without the design work.</em></h1>
          <p>Tell Kely what you want to say. Kely shapes the plan with you, learns your style, and turns it into a finished LinkedIn or Instagram post.</p>
          <a className="button primary public-cta" href="#waitlist">Join the private beta<ArrowRight size={18} aria-hidden="true" /></a>
          <span className="public-note">No editor to learn · You approve the plan first</span>
        </div>
        <div className="public-hero-art" aria-label="Concept example of a Kely design conversation and finished social post">
          <div className="public-chat-card">
            <span>Kely</span>
            <p>I suggest a 3-slide launch post: a bold promise, one clear product proof, and a simple next step.</p>
            <strong>Plan approved</strong>
          </div>
          <figure>
            <img src="/examples/girex-product.png" alt="Concept example: dark product carousel cover with a bold headline and product interface" />
            <figcaption>Concept example</figcaption>
          </figure>
        </div>
      </section>

      <section className="public-proof" aria-labelledby="proof-title">
        <span className="section-eyebrow">HOW KELY WORKS</span>
        <h2 id="proof-title">Like working with a designer.<br /><em>Only much faster.</em></h2>
        <div className="public-steps">
          <article><span>01</span><h3>Bring an idea</h3><p>Start with one sentence. Kely asks only what is needed.</p></article>
          <article><span>02</span><h3>Approve the plan</h3><p>See the copy, slides, caption, and visual direction before generation.</p></article>
          <article><span>03</span><h3>Refine in words</h3><p>Ask for a focused change. Kely remembers lasting preferences for next time.</p></article>
        </div>
      </section>

      <section className="public-examples" aria-labelledby="examples-title">
        <header><span className="section-eyebrow">CONCEPT EXAMPLES</span><h2 id="examples-title">One system. <em>Your visual language.</em></h2><p>Early concept work illustrating the range Kely is being built for.</p></header>
        <div className="public-example-grid">
          <figure><img src="/examples/girex-product.png" alt="Dark product launch carousel concept" /><figcaption>Product launch · LinkedIn</figcaption></figure>
          <figure><img src="/examples/bakery-neighborhood.png" alt="Warm neighborhood bakery social post concept" /><figcaption>Local business · Instagram</figcaption></figure>
          <figure><img src="/examples/bakery-opening.png" alt="Bold bakery opening announcement concept" /><figcaption>Announcement · Instagram</figcaption></figure>
        </div>
      </section>

      <section id="waitlist" className="waitlist-panel" aria-labelledby="waitlist-title">
        <div><span className="section-eyebrow">PRIVATE BETA</span><h2 id="waitlist-title">Bring your next post idea.</h2><p>Join the waitlist for early access. We’ll invite a small group while we refine the quality.</p></div>
        {status === "done" ? <div className="waitlist-success" role="status"><span aria-hidden="true">✓</span><p>{message}</p></div> : <form onSubmit={joinWaitlist}>
          <label htmlFor="waitlist-email">Work email</label>
          <div className="waitlist-input"><Mail size={19} aria-hidden="true" /><input id="waitlist-email" type="email" inputMode="email" autoComplete="email" maxLength={254} placeholder="you@company.com" value={email} onChange={event => setEmail(event.target.value)} required aria-describedby="waitlist-consent waitlist-status" /><button className="button primary" disabled={status === "sending"}>{status === "sending" ? "Joining…" : "Join the waitlist"}<ArrowRight size={17} aria-hidden="true" /></button></div>
          <p id="waitlist-consent" className="field-hint">By joining, you agree to receive emails about Kely access. No spam.</p>
          {message && <p id="waitlist-status" role="alert" className="waitlist-error">{message}</p>}
        </form>}
      </section>
    </main>
    <footer className="public-footer"><KelyLogo small /><span>AI design help for small businesses.</span><a href="/beta-info">Privacy</a></footer>
  </div>;
}

export function AuthScreen({
  inviteOnly = false,
  mode,
  setMode,
  onSubmit,
  busy,
  onBack,
}: {
  inviteOnly?: boolean;
  mode: "signup" | "signin";
  setMode: (mode: "signup" | "signin") => void;
  onSubmit: (values: { name: string; email: string; password: string }) => void;
  busy: boolean;
  onBack: () => void;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onSubmit({
      name: String(form.get("name") ?? ""),
      email: String(form.get("email")),
      password: String(form.get("password")),
    });
  }
  return (
    <>
      <header className="site-header">
        <Brand onClick={onBack} />
        <button className="text-button" onClick={onBack}>
          Back to Kely
        </button>
      </header>
      <main id="main-content" className="auth-layout" tabIndex={-1}>
        <section className="auth-card">
          <h1>
            {mode === "signup"
              ? "Your ideas belong here."
              : "Welcome back."}
          </h1>
          <p className="muted">
            {mode === "signup"
              ? "Create your account. Your idea is saved."
              : "Pick up where you left off."}
          </p>
          <form onSubmit={submit} key={mode}>
            {mode === "signup" && (
              <label>
                Your name
                <input
                  name="name"
                  autoComplete="name"
                  required
                  maxLength={100}
                />
              </label>
            )}
            <label>
              Email address
              <input
                type="email"
                name="email"
                autoComplete="email"
                required
                maxLength={254}
              />
            </label>
            <label>
              Password
              <input
                type="password"
                name="password"
                autoComplete={
                  mode === "signup" ? "new-password" : "current-password"
                }
                required
                minLength={10}
                maxLength={128}
              />
            </label>
            {mode === "signup" && <p className="field-hint">At least 10 characters.</p>}
            {mode === "signup" && <p className="field-hint">By creating an account, you agree to the <a href="/beta-info" target="_blank" rel="noreferrer">terms and privacy information</a>.</p>}
            <button className="button primary full-width" disabled={busy}>
              {busy
                ? "One moment…"
                : mode === "signup"
                  ? "Create account"
                  : "Log in"}
              <ArrowRight size={17} aria-hidden="true" />
            </button>
          </form>
          {inviteOnly ? <p className="auth-switch">Private beta access only. Sign in with the account provided to you.</p> : <p className="auth-switch">
            {mode === "signup" ? "Already have an account?" : "New to Kely?"}{" "}
            <button
              className="text-button"
              disabled={busy}
              onClick={() => setMode(mode === "signup" ? "signin" : "signup")}
            >
              {mode === "signup" ? "Log in" : "Create an account"}
            </button>
          </p>}
          <p className="field-hint"><a href="/recover">Forgot your password?</a> Ask the operator for a recovery link.</p>
        </section>
        <aside className="auth-aside">
          <span className="eyebrow">AN IDEA IS ENOUGH TO BEGIN.</span>
          <h2>
            Less blank page.
            <br />
            <em>More you.</em>
          </h2>
          <p>
            Your business. Your personality. A designer to help bring it into
            focus.
          </p>
        </aside>
      </main>
    </>
  );
}

export function Plans({
  account,
  busy,
  onAction,
  onboarding = false,
}: {
  account: AccountView;
  busy: boolean;
  onAction: (
    action: "activate" | "upgrade" | "topup" | "cancel" | "resume" | "schedule_change" | "clear_change" | "renew",
    tier?: "starter" | "studio",
    cadence?: Cadence,
  ) => void;
  onboarding?: boolean;
}) {
  const [cadence, setCadence] = useState<Cadence>(account.billing.cadence);
  const active =
    account.billing.tier !== "none" &&
    !!account.billing.activeUntil &&
    new Date(account.billing.activeUntil).getTime() > Date.now();
  return (
    <section className="plans-section">
      <span className="eyebrow">ROOM TO CREATE</span>
      <h1>
        {onboarding
          ? "Meet your new designer."
          : "Keep the ideas coming."}
      </h1>
      <p className="section-description">
        Same creative tools. More room when you need it.
      </p>
      <fieldset className="cadence-choice" disabled={busy}>
        <legend className="sr-only">Billing frequency</legend>
        <label>
          <input
            type="radio"
            name="cadence"
            value="monthly"
            checked={cadence === "monthly"}
            onChange={() => setCadence("monthly")}
          />
          <span>Monthly</span>
        </label>
        <label>
          <input
            type="radio"
            name="cadence"
            value="annual"
            checked={cadence === "annual"}
            onChange={() => setCadence("annual")}
          />
          <span>Yearly</span>
        </label>
      </fieldset>
      <p className="field-hint centered">
        Credits refresh weekly with either option.
      </p>
      {active && cadence === account.billing.cadence && (
        <p className="field-hint centered">
          Your current billing frequency.
        </p>
      )}
      {active && cadence !== account.billing.cadence && (
        <p className="field-hint centered">Your current {account.billing.cadence} period stays unchanged until renewal.</p>
      )}
      <div className="plans-grid">
        {(["starter", "studio"] as const).map((tier) => {
          const current = active && account.billing.tier === tier;
          const currentChoice = current && cadence === account.billing.cadence;
          return (
            <article
              className={`plan-card ${tier === "studio" ? "plan-studio" : ""}`}
              key={tier}
            >
              <div className="plan-card-heading">
                <h2>{tier === "starter" ? "Starter" : "Studio"}</h2>
                {tier === "studio" && (
                  <span className="small-label">MORE ROOM TO CREATE</span>
                )}
              </div>
              <p>
                {tier === "starter"
                  ? "Find your rhythm."
                  : "Keep the ideas coming."}
              </p>
              <div className="plan-allowance">
                {tier === "starter" ? "100" : "300"}
                <span>credits / week</span>
              </div>
              <ul className="feature-list">
                <li>
                  <Check size={16} />
                  LinkedIn & Instagram posts
                </li>
                <li>
                  <Check size={16} />
                  Chat-based changes
                </li>
                <li>
                  <Check size={16} />
                  Your saved business & style
                </li>
                <li>
                  <Check size={16} />
                  Downloads & publication history
                </li>
              </ul>
              <button
                className={`button ${tier === "studio" ? "primary" : "secondary"} full-width`}
                disabled={busy || currentChoice}
                onClick={() => {
                  if (!active) onAction("activate", tier, cadence);
                  else if (account.billing.tier === "starter" && tier === "studio") onAction("upgrade", tier, account.billing.cadence);
                  else onAction("schedule_change", tier, cadence);
                }}
              >
                {currentChoice
                  ? "Current plan"
                  : active && account.billing.tier === "starter" && tier === "studio"
                    ? "Move to Studio"
                    : active
                      ? `Schedule ${tier === "starter" ? "Starter" : "Studio"} · ${cadence === "annual" ? "yearly" : "monthly"}`
                      : `Choose ${tier === "starter" ? "Starter" : "Studio"}`}
              </button>
            </article>
          );
        })}
      </div>
      <p className="billing-preview-disclosure">
        Founder access · no charge. These allowances are for local testing; commercial pricing is not available yet.
      </p>
      <details className="credit-explainer">
        <summary>How credits work</summary>
        <p>
          Your action shows its credit cost before it starts. Weekly
          credits refresh every seven days without rollover. One-off pack
          credits stay available and are spent after weekly credits.
        </p>
      </details>
      {!onboarding && (
        <div className="billing-details">
          <div className="balance-grid">
            <div>
              <span>Weekly credits</span>
              <strong>{account.billing.weeklyRemaining}</strong>
            </div>
            <div>
              <span>Pack credits</span>
              <strong>{account.billing.packRemaining}</strong>
            </div>
            <div>
              <span>Reserved for work</span>
              <strong>{account.billing.reserved}</strong>
            </div>
          </div>
          <dl className="billing-dates">
            <div>
              <dt>Next weekly refresh</dt>
              <dd>{displayDate(account.billing.nextResetAt)}</dd>
            </div>
            <div>
              <dt>Access until</dt>
              <dd>{displayDate(account.billing.activeUntil)}</dd>
            </div>
          </dl>
          {(account.billing.pendingTier || account.billing.pendingCadence) && (
            <div className="simulation-notice" role="status">
              <Info size={18} aria-hidden="true" />
              <div><strong>Next renewal</strong><p>{account.billing.pendingTier ?? account.billing.tier} · {account.billing.pendingCadence ?? account.billing.cadence}.</p><button className="text-button" disabled={busy} onClick={() => onAction("clear_change")}>Keep current plan instead</button></div>
            </div>
          )}
          <details className="billing-controls">
          <summary>Manage plan</summary>
          <div className="billing-actions">
            <button
              className="button secondary"
              disabled={busy || !active}
              onClick={() => onAction("topup")}
            >
              Add 50 credits
            </button>
            <button
              className="text-button"
              disabled={busy || !active}
              onClick={() => onAction(account.billing.cancelAtPeriodEnd ? "resume" : "cancel")}
            >
              {account.billing.cancelAtPeriodEnd
                ? "Resume subscription"
                : "Cancel subscription"}
            </button>
          </div>
          <p className="field-hint">
            Cancellation preserves access until the paid period ends. Existing
            downloads and purchased credits remain available.
          </p>
          </details>
        </div>
      )}
    </section>
  );
}
