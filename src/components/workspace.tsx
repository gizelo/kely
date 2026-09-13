"use client";

import Image from "next/image";
import {
  ArrowDownToLine,
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  FileText,
  Maximize2,
  MessageCircle,
  Send,
  PencilLine,
  X,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type {
  AccountView,
  BusinessView,
  OperationKind,
  PublicationView,
  QuoteView,
} from "../shared/contracts";
import { displayDate } from "./api";
import type { BrandView, PublicationBrief } from "../shared/brand";
import { useBrandData, type RunBrandAction } from "./brand-data";
import { PublicationBrandPanel } from "./brand-brief";
import { BrandCapabilities, paletteOptions } from "./brand-workspace";
import { KelyLogo } from "./identity";
import { DirectionSummary } from "./art-direction-editor";
import {
  CreativeBriefReview,
  SlideCreativeSummary,
  designSceneDescription,
} from "./creative-review";
import {
  PreferenceSuggestions,
  type PreferenceConfirmation,
} from "./preference-suggestions";
import {
  CostDetails,
  OriginBadge,
  originExplanation,
  originLabel,
} from "./origin";

function publicationLanguage(value: string) {
  const normalized = value.trim().toLocaleLowerCase();
  if (/^(ru|rus|russian|рус)/u.test(normalized)) return "ru";
  if (/^(de|deu|ger|german|deutsch)/u.test(normalized)) return "de";
  if (/^(uk|ukr|ukrainian|укра)/u.test(normalized)) return "uk";
  if (/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/iu.test(normalized)) return normalized;
  return "en";
}

function savedSlideDescription(
  slide: PublicationView["slides"][number],
  direction?: PublicationView["artDirection"],
) {
  const copy = `Slide ${slide.index + 1}: ${slide.title}. ${slide.body}`;
  const plan = slide.creativePlan;
  if (!plan) return `${copy} Visual: saved typographic composition.`;
  if (plan.scene) {
    const description = designSceneDescription(plan.scene, direction);
    return `${copy} Visual: ${description.idea} ${description.source}`;
  }
  const originalIndex = direction?.originals.findIndex(
    (item) => item.id === plan.materialId,
  ) ?? -1;
  const material = plan.materialId
    ? originalIndex >= 0
      ? `saved original ${originalIndex + 1}`
      : "a selected original"
    : "no image";
  const recipe = {
    "type-poster": "type-led poster",
    "graphic-stage": "original graphic in focus",
    "split-proof": "copy beside visual evidence",
    "image-evidence": "image-led evidence",
    closing: "focused closing frame",
  }[plan.recipe];
  const color = direction?.direction.palette[plan.background];
  return `${copy} Visual: ${recipe} using ${material}; ${plan.alignment}-aligned ${plan.heading} heading${color ? ` on ${color}` : ""}.`;
}

function SemanticDirectionReview({
  proposal,
  contentLang,
}: {
  proposal: NonNullable<PublicationView["directionProposal"]>;
  contentLang: string;
}) {
  const direction = proposal.direction;
  const label = (value: string) => value.replaceAll("-", " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
  return (
    <section className="semantic-direction-review" aria-labelledby="semantic-direction-title">
      <div>
        <span className="small-label">{proposal.status === "pending" ? "KELY’S PROPOSED STYLE" : "APPROVED STYLE"}</span>
        <h3 id="semantic-direction-title">A visual direction for this post.</h3>
        <p lang={contentLang} dir="auto">{direction.rationale}</p>
      </div>
      <dl>
        <div><dt>Mood</dt><dd>{label(direction.tone)}</dd></div>
        <div><dt>Visual language</dt><dd>{label(direction.grammar)}</dd></div>
        <div><dt>Type</dt><dd>{label(direction.headingFont)}</dd></div>
        <div><dt>Spacing</dt><dd>{label(direction.spacing)}</dd></div>
      </dl>
      <div className="semantic-palette" aria-label="Proposed palette">
        {Object.entries(direction.palette).map(([role, color]) => (
          <span key={role}><i style={{ backgroundColor: color }} aria-hidden="true" /><b>{label(role)}</b><small>{color}</small></span>
        ))}
      </div>
      {proposal.status === "pending" && <p className="field-hint">This belongs only to this post. Kely will not change your saved Brand unless you ask.</p>}
    </section>
  );
}

export const statusLabels: Record<PublicationView["status"], string> = {
  collecting: "Shaping your idea",
  content_approval: "Content to approve",
  cover_approval: "Style to approve",
  cover_approved: "Style approved",
  running: "Work in progress",
  ready: "Ready to download",
  failed: "Needs attention",
};

export function PublicationWorkspace({
  publication: p,
  busy,
  onMessage,
  onQuote,
  onApprove,
  onBilling,
  onNew,
  canEditBrand,
  run,
  onError,
  onSaveBrief,
  onOpenBrand,
  onConfirmPreference,
}: {
  publication: PublicationView;
  busy: boolean;
  onMessage: (text: string) => Promise<boolean>;
  onQuote: (kind: OperationKind, instruction?: string) => Promise<boolean>;
  onApprove: (stage: "content" | "cover") => void;
  onBilling: () => void;
  onNew: () => void;
  canEditBrand: boolean;
  run: RunBrandAction;
  onError: (error: unknown) => void;
  onSaveBrief: (brief: PublicationBrief) => Promise<boolean>;
  onOpenBrand: () => void;
  onConfirmPreference: (input: PreferenceConfirmation) => Promise<BrandView>;
}) {
  const brandData = useBrandData(onError, run);
  const [message, setMessage] = useState("");
  const [briefDirty, setBriefDirty] = useState(false);
  const [slideIndex, setSlideIndex] = useState(0);
  const [panel, setPanel] = useState<"conversation" | "preview">(
    p.status === "ready" ? "preview" : "conversation",
  );
  const [mobilePanels, setMobilePanels] = useState(false);
  const feed = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const contextPanel = useRef<HTMLDetailsElement>(null);
  const visualFrame = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 900px)");
    const update = () => setMobilePanels(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  function selectPanel(next: "conversation" | "preview") {
    setPanel(next);
    requestAnimationFrame(() => document.getElementById(`workspace-tab-${next}`)?.focus());
  }
  function movePanel(event: KeyboardEvent<HTMLButtonElement>, current: "conversation" | "preview") {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    selectPanel(event.key === "ArrowLeft" || event.key === "Home" ? "conversation" : event.key === "ArrowRight" || event.key === "End" ? "preview" : current);
  }
  const operation = p.pendingOperation;
  const pending =
    operation?.status === "queued" || operation?.status === "running";
  const uncertain = operation?.status === "uncertain";
  const blocked = busy || pending || uncertain || briefDirty;
  const readinessBlocked = Boolean(
    p.brandBrief && p.readiness && !p.readiness.ready,
  );
  const creativeFactsBlocked = Boolean(p.proposedBrief?.requiredFacts.length);
  const collecting = p.status === "collecting";
  const creative = [
    "creative-intent-v1",
    "creative-intent-v2",
    "creative-intent-v3",
    "creative-intent-v4",
    "creative-intent-v5",
    "creative-intent-v6",
    "creative-intent-v7",
    "creative-intent-v8",
    "creative-intent-v9",
  ].includes(p.designPolicy ?? "");
  const failed = p.status === "failed";
  const preparation = p.preparation;
  const preparationPaused =
    !preparation?.closed &&
    (preparation?.paused ||
      Boolean(
        preparation &&
          preparation.attemptsUsed >= 4 &&
          preparation.repliesRemaining > 0,
      ));
  const acceptsContext =
    !p.outlineApproved &&
    !preparation?.closed &&
    (collecting ||
      p.status === "content_approval" ||
      (failed && p.failedOperationKind === "prepare"));
  const pendingVisualTargets = p.pendingVisualTargets ?? [];
  const firstRevisedSlide = pendingVisualTargets[0];
  const revisedTitle = p.slides[firstRevisedSlide - 1]?.title;
  const revisedBody = p.slides[firstRevisedSlide - 1]?.body;
  const revisedPlan = JSON.stringify(
    p.slides[firstRevisedSlide - 1]?.creativePlan,
  );
  const acceptsRevision =
    p.status === "ready" ||
    p.status === "cover_approval" ||
    (failed && p.failedOperationKind === "revise") ||
    (p.status === "content_approval" && pendingVisualTargets.length > 0);
  const composerBlocked = blocked || (!acceptsContext && !acceptsRevision);
  const slide = p.slides[Math.min(slideIndex, p.slides.length - 1)];
  const hasCover = !!p.slides[0]?.assetId;
  const ready = p.status === "ready";
  const contentLang = publicationLanguage(p.language);
  const exportBase = "/api/kely/publications/" + p.id + "/export?format=";
  const coverAssetId = p.slides[0]?.assetId;
  useEffect(() => {
    const frame = visualFrame.current;
    if (!ready || !frame) return;
    let scheduled = 0;
    function measure() {
      if (!frame) return;
      if (!window.matchMedia("(min-width: 901px)").matches) {
        frame.style.removeProperty("--ready-image-height");
        return;
      }
      const top = Math.max(
        0,
        frame.getBoundingClientRect().top + window.scrollY,
      );
      const height = Math.max(160, Math.floor(window.innerHeight - top - 104));
      const value = height + "px";
      if (frame.style.getPropertyValue("--ready-image-height") !== value)
        frame.style.setProperty("--ready-image-height", value);
    }
    function schedule() {
      cancelAnimationFrame(scheduled);
      scheduled = requestAnimationFrame(measure);
    }
    const observer = new ResizeObserver(schedule);
    const regions = [
      frame.closest(".workspace-main"),
      frame
        .closest(".publication-workspace")
        ?.querySelector(".workspace-heading"),
      frame.closest(".preview-panel")?.querySelector(".preview-toolbar"),
      document.querySelector(".fixture-banner"),
    ];
    for (const region of regions) if (region) observer.observe(region);
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(scheduled);
      window.removeEventListener("resize", schedule);
      frame.style.removeProperty("--ready-image-height");
    };
  }, [ready, slide?.assetId]);
  useEffect(() => {
    if (p.status === "cover_approval" && coverAssetId) {
      setSlideIndex(0);
      setPanel("preview");
    }
  }, [p.status, coverAssetId]);
  useEffect(() => {
    if (
      p.status === "content_approval" &&
      !p.outlineApproved &&
      firstRevisedSlide >= 1 &&
      firstRevisedSlide <= p.slides.length
    ) {
      setSlideIndex(firstRevisedSlide - 1);
      setPanel("preview");
    }
  }, [
    p.status,
    p.outlineApproved,
    firstRevisedSlide,
    p.slides.length,
    revisedTitle,
    revisedBody,
    revisedPlan,
  ]);
  useEffect(() => {
    feed.current?.scrollTo({
      top: feed.current.scrollHeight,
      behavior: "instant",
    });
  }, [p.messages.length]);
  useEffect(() => {
    if (
      operation?.kind === "revise" &&
      (operation.status === "queued" || operation.status === "running")
    )
      setMessage("");
  }, [operation?.id, operation?.kind, operation?.status]);
  async function send(event: FormEvent) {
    event.preventDefault();
    if (!message.trim()) return;
    const success = acceptsContext
      ? await onMessage(message.trim())
      : await onQuote("revise", message.trim());
    if (success && acceptsContext) setMessage("");
  }
  function showPreview() {
    setPanel("preview");
    requestAnimationFrame(() => preview.current?.focus());
  }
  function showContext() {
    if (!contextPanel.current) return;
    contextPanel.current.open = true;
    contextPanel.current.querySelector("summary")?.focus();
    contextPanel.current.scrollIntoView({ block: "start" });
  }
  function showConversation() {
    setPanel("conversation");
    requestAnimationFrame(() => {
      composer.current?.focus();
      composer.current?.scrollIntoView({ block: "center" });
    });
  }
  const messageHistory = p.messages.map((item) => (
    <div className={"chat-message message-" + item.role} key={item.id}>
      <span className="small-label">
        {item.role === "user" ? "YOU" : "KELY"}
      </span>
      {item.role === "assistant" && <OriginBadge origin={item.origin} />}
      <p dir="auto">{item.text}</p>
    </div>
  ));
  const postContext = (
    <details
      ref={contextPanel}
      className="post-context-disclosure"
      open={
        briefDirty ||
        Boolean(!p.outlineApproved && p.brandBrief?.blockingFacts.length)
      }
    >
      <summary>
        Post context &amp; Brand
        {briefDirty
          ? " · unsaved changes"
          : readinessBlocked
            ? " · details to review"
            : ""}
      </summary>
      <PublicationBrandPanel
        publication={p}
        busy={busy}
        canEdit={canEditBrand}
        run={run}
        data={brandData}
        onSave={onSaveBrief}
        onDirtyChange={setBriefDirty}
        onOpenBrand={onOpenBrand}
      />
    </details>
  );
  const exportActions = (
    <div className="export-actions">
      <a
        className="button primary"
        href={exportBase + (p.slideCount === 1 ? "png" : "zip")}
        download
      >
        <ArrowDownToLine size={16} />
        {p.slideCount === 1 ? "Download PNG" : "Download images"}
      </a>
      {ready && (
        <button className="button secondary" type="button" onClick={showConversation}>
          <PencilLine size={16} />
          Ask Kely for a change
        </button>
      )}
      {ready ? (
        <details className="more-downloads">
          <summary>Download options</summary>
          <div>
            {p.platform === "linkedin" && p.slideCount > 1 && (
              <a className="button secondary" href={exportBase + "pdf"} download>
                PDF carousel
              </a>
            )}
            <a className="button secondary" href={exportBase + "caption"} download>
              Caption
            </a>
          </div>
        </details>
      ) : (
        <>
          {p.platform === "linkedin" && p.slideCount > 1 && (
            <a className="button secondary" href={exportBase + "pdf"} download>
              PDF carousel
            </a>
          )}
          <a className="button secondary" href={exportBase + "caption"} download>
            Caption
          </a>
        </>
      )}
    </div>
  );
  return (
    <section className={"publication-workspace" + (ready ? " is-ready" : "")}>
      <div className="workspace-heading">
        <div>
          <span className="eyebrow">
            {p.platform.toUpperCase()} ·{" "}
            {p.slideCount === 1
              ? "SINGLE IMAGE"
              : p.slideCount + "-SLIDE CAROUSEL"}
          </span>
          <h1 dir="auto" lang={publicationLanguage(p.language)}>{p.slides[0]?.title || "Let’s shape your idea."}</h1>
        </div>
      </div>
      <nav className="workflow-steps" aria-label="Publication progress">
        {!ready &&
          ["Story", "Style", "Post"].map((label, index) => {
            const complete =
              index === 0
                ? p.outlineApproved
                : index === 1
                  ? p.coverApproved
                  : ready;
            return (
              <span
                key={label}
                className={"workflow-step" + (complete ? " step-complete" : "")}
              >
                <span>{complete ? <Check size={12} /> : index + 1}</span>
                {label}
              </span>
            );
          })}
        <span className={"status-pill " + (ready ? "status-ready" : "")}>
          {ready ? <Check size={14} /> : <Clock3 size={14} />}
          {statusLabels[p.status]}
        </span>
        <span className="version-tag">Saved · v{p.version}</span>
      </nav>
      {!ready && postContext}
      <div
        className="mobile-panel-choice"
        role={mobilePanels ? "tablist" : undefined}
        aria-label={mobilePanels ? "Workspace panel" : undefined}
      >
        <button
          id="workspace-tab-conversation"
          role={mobilePanels ? "tab" : undefined}
          className={panel === "conversation" ? "selected" : ""}
          aria-selected={mobilePanels ? panel === "conversation" : undefined}
          aria-controls={mobilePanels ? "workspace-panel-conversation" : undefined}
          tabIndex={mobilePanels ? (panel === "conversation" ? 0 : -1) : -1}
          onKeyDown={(event) => movePanel(event, "conversation")}
          onClick={() => selectPanel("conversation")}
        >
          <MessageCircle size={16} />
          Conversation
        </button>
        <button
          id="workspace-tab-preview"
          role={mobilePanels ? "tab" : undefined}
          className={panel === "preview" ? "selected" : ""}
          aria-selected={mobilePanels ? panel === "preview" : undefined}
          aria-controls={mobilePanels ? "workspace-panel-preview" : undefined}
          tabIndex={mobilePanels ? (panel === "preview" ? 0 : -1) : -1}
          onKeyDown={(event) => movePanel(event, "preview")}
          onClick={() => selectPanel("preview")}
        >
          <FileText size={16} />
          Your post
        </button>
      </div>
      <div className={"creative-columns mobile-" + panel}>
        <section id="workspace-panel-conversation" role={mobilePanels ? "tabpanel" : "region"} aria-labelledby={mobilePanels ? "workspace-tab-conversation" : undefined} aria-label={mobilePanels ? undefined : "Conversation"} className="conversation-panel">
          <div className="panel-heading">
            {!ready && <KelyLogo small />}
            <div>
              <h2>
                {ready ? "Tell Kely what to change." : "Let’s shape your post."}
              </h2>
              <span>
                {ready
                  ? "One clear request is enough"
                  : "Your private design conversation"}
              </span>
            </div>
          </div>
          <div
            className="message-feed"
            ref={feed}
            role="log"
            aria-label="Conversation messages"
            aria-live="polite"
          >
            <div className="welcome-message">
              <span className="small-label">KELY</span>
              <p>
                {collecting
                  ? "Start with what matters. Who is this for, and what would you like them to take away? Add anything useful, or let’s prepare a first outline."
                  : ready
                    ? "Your post is ready. Tell me what to change, or download it as it is."
                    : "Your story comes first. Review the words, then we’ll agree on a look. Ask for changes here whenever you need."}
              </p>
              <span className="message-note">
                {ready
                  ? "I’ll show you the price before changing anything."
                  : "Saving a message is free. Each assistant reply or design action needs your confirmation first."}
              </span>
            </div>
            {ready && p.messages.length > 0 ? (
              <details className="conversation-history">
                <summary>
                  Earlier conversation · {p.messages.length} messages
                </summary>
                {messageHistory}
              </details>
            ) : (
              messageHistory
            )}
            <PreferenceSuggestions
              publication={p}
              data={brandData}
              disabled={blocked || !canEditBrand}
              onConfirm={onConfirmPreference}
            />
          </div>
          <div className="conversation-bottom">
            {preparation && !ready && (
              <details
                className="preparation-package"
                open={Boolean(preparationPaused)}
              >
                <summary>
                  {preparationPaused
                    ? "Preparation needs review"
                    : preparation.closed
                      ? "Preparation completed"
                      : `${preparation.repliesRemaining} preparation replies available`}
                </summary>
                <div>
                  <strong>
                    {preparationPaused
                      ? "Preparation paused for review"
                      : preparation.closed
                        ? "Preparation completed"
                        : preparation.activated
                          ? "Your preparation is active"
                          : "Preparation awaits its first usable reply"}
                  </strong>
                  <OriginBadge origin={preparation.origin} />
                </div>
                <p>
                  {preparation.closed ? (
                    "Content approval closed this package. Unused replies are not transferred; later changes receive a separate quote."
                  ) : (
                    <>
                      {preparation.repliesRemaining} of 3 usable replies
                      remaining · {preparation.attemptsUsed} of 4 attempts used.
                    </>
                  )}
                </p>
                {preparationPaused ? (
                  <p>
                    Prior work and unused replies are preserved. The local
                    coordinator must review this; buying another package is not
                    the remedy.
                  </p>
                ) : (
                  !preparation.closed && (
                    <p>
                      {preparation.activated
                        ? "Included replies have no additional credit charge."
                        : "The package charge activates only when the first usable reply is saved."}{" "}
                      One explicit known-failure retry fits within the
                      four-attempt cap. Nothing retries automatically.
                    </p>
                  )
                )}
              </details>
            )}
            {pending && (
              <div className="operation-notice" role="status">
                <span className="activity-dot" />
                <div>
                  <strong>
                    {operation.status === "queued"
                      ? "Waiting for the local worker"
                      : "The local worker is processing your post"}
                  </strong>
                  <p>
                    You can leave this page. We’ll read the saved result when
                    you return.
                  </p>
                  <OriginBadge origin={operation.origin} />
                </div>
              </div>
            )}
            {uncertain && (
              <div className="warning-note" role="status">
                <strong>Outcome needs reconciliation.</strong>
                <p>
                  We won’t automatically repeat this operation. Your saved
                  version is preserved; the coordinator needs to check its
                  outcome.
                </p>
              </div>
            )}
            {p.failure && (
              <p className="warning-note" role="status">
                {p.failure} Your last saved version is preserved.
              </p>
            )}
            {p.failureCode === "budget_exhausted" && (
              <p className="warning-note">
                The founder’s local development API budget cannot cover this
                work. Customer credits or an upgrade cannot raise that limit.
              </p>
            )}
            <form onSubmit={send} className="chat-composer">
              <label className="sr-only" htmlFor="chat-message">
                {acceptsContext ? "Additional context" : "Requested change"}
              </label>
              <textarea
                ref={composer}
                id="chat-message"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                disabled={composerBlocked}
                rows={3}
                maxLength={2000}
                placeholder={
                  acceptsContext
                    ? "They’re local coffee lovers. Keep it friendly…"
                    : creative
                      ? "Change the visual plan on slide 2…"
                      : "Try a different color treatment on slide 2…"
                }
              />
              <div>
                <span>
                  {acceptsContext
                    ? "Saves context only · no credits spent"
                    : "I’ll scope the change before anything runs"}
                </span>
                <button
                  id="post-message-submit"
                  className="icon-button send-button"
                  aria-label={
                    acceptsContext
                      ? "Save context message"
                      : "Get revision quote"
                  }
                  disabled={composerBlocked || !message.trim()}
                >
                  <Send size={17} />
                </button>
              </div>
            </form>
            <p className="composer-footnote">
              {acceptsContext
                ? "Save any additional context, then review preparation. Included replies quote 0 additional credits. Content approval closes preparation."
                : acceptsRevision
                  ? creative
                    ? "Describe the result you want in your own words. I’ll confirm the affected slide and total likely cost before anything runs."
                    : "Name one slide and say whether to change its copy or style. You’ll review the interpreted scope first; cancelling keeps your request editable."
                  : "Complete the current stage to request another change."}
            </p>
            {!ready && <div className="conversation-next-step">
              <p>
                {collecting
                  ? "Review the preparation price. Nothing runs until you confirm the quote."
                  : ready
                    ? "Your saved images and caption are ready to download."
                    : "Review your saved post and the next approval or recovery step."}
              </p>
              <button
                type="button"
                className="button primary full-width"
                disabled={
                  collecting
                    ? blocked || preparationPaused || !acceptsContext
                    : busy
                }
                onClick={
                  collecting ? () => void onQuote("prepare") : showPreview
                }
              >
                {collecting
                  ? preparation?.activated && preparation.repliesRemaining > 0
                    ? "Review included preparation · 0 credits"
                    : "Review preparation"
                  : ready
                    ? "View & download your post"
                    : p.status === "content_approval"
                      ? "Review content & next steps"
                      : p.status === "cover_approval"
                        ? "Review cover & next steps"
                        : "Review next step"}
                <ArrowRight size={16} />
              </button>
            </div>}
            {ready && postContext}
          </div>
        </section>
        <section
          id="workspace-panel-preview"
          role={mobilePanels ? "tabpanel" : "region"}
          aria-labelledby={mobilePanels ? "workspace-tab-preview" : undefined}
          ref={preview}
          tabIndex={-1}
          className="preview-panel"
          aria-label={mobilePanels ? undefined : "Publication preview"}
        >
          {!hasCover && (
            <div className="preview-heading">
              <h2>Your story, before the design</h2>
              <span className="small-label">
                {p.language || "YOUR LANGUAGE"}
              </span>
            </div>
          )}
          {p.slides.length ? (
            <>
              <div className="preview-toolbar">
                {p.slides.length > 1 && (
                  <div className="slide-pager">
                    <button
                      className="icon-button"
                      aria-label="Previous slide"
                      disabled={slideIndex === 0}
                      onClick={() =>
                        setSlideIndex((index) => Math.max(0, index - 1))
                      }
                    >
                      <ChevronLeft size={17} />
                    </button>
                    <span role="status" aria-live="polite" aria-atomic="true">
                      Slide {Math.min(slideIndex + 1, p.slides.length)} of{" "}
                      {p.slides.length}
                    </span>
                    <button
                      className="icon-button"
                      aria-label="Next slide"
                      disabled={slideIndex >= p.slides.length - 1}
                      onClick={() =>
                        setSlideIndex((index) =>
                          Math.min(p.slides.length - 1, index + 1),
                        )
                      }
                    >
                      <ChevronRight size={17} />
                    </button>
                  </div>
                )}
                {slide && (
                  <div className="slide-provenance">
                    <details className="result-details">
                      <summary>About this result</summary>
                      <div>
                        <OriginBadge
                          origin={slide.copyOrigin}
                          visual={
                            slide.assetId
                              ? (slide.visualOrigin ?? "fixture")
                              : undefined
                          }
                        />
                        <span>
                          {slide.assetId ? "Saved visual" : "Proposed copy"}
                        </span>
                        {ready && slide.assetId && (
                          <SavedImageViewer
                            key={slide.assetId}
                            slide={slide}
                            assetId={slide.assetId}
                            direction={slide.artDirection ?? p.artDirection}
                            language={publicationLanguage(p.language)}
                          />
                        )}
                      </div>
                    </details>
                  </div>
                )}
              </div>
              {slide?.assetId ? (
                <div ref={visualFrame} className="generated-slide">
                  <Image
                    src={
                      "/api/kely/assets/" + encodeURIComponent(slide.assetId)
                    }
                    alt={
                      savedSlideDescription(
                        slide,
                        slide.artDirection ?? p.artDirection,
                      )
                    }
                    lang={publicationLanguage(p.language)}
                    width={1080}
                    height={1350}
                    unoptimized
                  />
                </div>
              ) : (
                <article className="outline-slide">
                  <span className="small-label">
                    CONTENT DRAFT · NO VISUAL GENERATED
                  </span>
                  <h3 dir="auto" lang={publicationLanguage(p.language)}>{slide?.title}</h3>
                  <p dir="auto" lang={publicationLanguage(p.language)}>{slide?.body}</p>
                  <span className="outline-footer">
                    {String((slide?.index ?? 0) + 1).padStart(2, "0")} /{" "}
                    {String(p.slideCount).padStart(2, "0")}
                  </span>
                </article>
              )}
              {ready && (
                <div className="ready-downloads">
                  {exportActions}
                  <span>Downloads are free</span>
                </div>
              )}
              {slide?.creativePlan && (
                <SlideCreativeSummary
                  plan={slide.creativePlan}
                  direction={slide.artDirection ?? p.artDirection}
                />
              )}
              {p.caption && (
                <details className="caption-panel" open={!ready}>
                  <summary>
                    Caption <span>Read-only · ask for changes in chat</span>
                  </summary>
                  <OriginBadge origin={p.captionOrigin} />
                  <p dir="auto" lang={publicationLanguage(p.language)}>{p.caption}</p>
                </details>
              )}
            </>
          ) : (
            <div className="empty-preview">
              <div className="empty-preview-art" aria-hidden="true">
                <span />
                <span />
                <span />
                <PencilLine size={25} />
              </div>
              <h3>
                A good post starts
                <br />
                with a little clarity.
              </h3>
              <p>
                Your outline will appear here after preparation. You’ll approve
                the story before any visual work.
              </p>
            </div>
          )}
          {p.directionProposal && (
            <SemanticDirectionReview
              proposal={p.directionProposal}
              contentLang={contentLang}
            />
          )}
          {p.proposedBrief && (
            <CreativeBriefReview
              brief={p.proposedBrief}
              analysis={p.sourceAnalysis}
              approved={p.outlineApproved}
              canChange={acceptsContext && !composerBlocked}
              onChange={showConversation}
            />
          )}
          <div className="approval-area">
            {p.uncertainFacts && p.uncertainFacts.length > 0 && (
              <div className="warning-note">
                <strong>Please verify these details before approving.</strong>
                <ul>
                  {p.uncertainFacts.map((fact, index) => (
                    <li key={index} dir="auto" lang={contentLang}>
                      {fact}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {failed &&
              p.failedOperationKind &&
              p.failedOperationKind !== "revise" &&
              !preparationPaused && (
                <>
                  <p>
                    Nothing restarts automatically. Review a fresh quote to
                    retry the failed {p.failedOperationKind} stage.
                  </p>
                  <button
                    className="button primary full-width"
                    disabled={blocked}
                    onClick={() => void onQuote(p.failedOperationKind!)}
                  >
                    Review retry quote
                    <ArrowRight size={16} />
                  </button>
                </>
              )}
            {failed && p.failedOperationKind === "revise" && (
              <p>
                Your previous output is preserved. Describe the requested change
                again in the conversation to get a fresh revision quote.
              </p>
            )}
            {!failed && acceptsContext && !preparationPaused && (
              <>
                <p>
                  {preparation?.repliesRemaining === 0
                    ? "Your three included replies are used. More preparation needs a new package quote before content approval."
                    : "Ready to find the angle? We’ll use your idea and saved context. Saving context alone does not generate a reply."}
                </p>
                <button
                  className={`button ${p.status === "content_approval" ? "secondary" : "primary"} full-width`}
                  disabled={blocked}
                  onClick={() => void onQuote("prepare")}
                >
                  {preparation?.activated && preparation.repliesRemaining > 0
                    ? "Review included reply · 0 credits"
                    : preparation?.repliesRemaining === 0
                      ? "Review new preparation package"
                      : "Review preparation quote"}
                  <ArrowRight size={16} />
                </button>
              </>
            )}
            {p.status === "content_approval" && !p.outlineApproved && (
              <>
                <p>
                  Check every claim and the slide copy. Approving confirms this
                  exact content version
                  {p.proposedBrief ? ", proposed brief, and slide plans" : ""}
                  {p.directionProposal?.status === "pending" ? ", plus the proposed visual direction" : ""}
                  {preparation && !preparation.closed
                    ? " and closes preparation, including any unused replies"
                    : ""}
                  .
                </p>
                {(readinessBlocked || briefDirty) && (
                  <p className="warning-note">
                    {briefDirty
                      ? "Save the changes in this post’s brief before approval."
                      : "Resolve the requirements in this post’s brief before content approval. Facts that change the copy must be prepared and reviewed again."}{" "}
                    <button className="text-button" onClick={showContext}>
                      Review post details
                    </button>
                  </p>
                )}
                <button
                  className="button primary full-width"
                  disabled={blocked || readinessBlocked || creativeFactsBlocked}
                  onClick={() => onApprove("content")}
                >
                  <Check size={17} />
                  {p.directionProposal?.status === "pending"
                    ? "Approve content & visual direction"
                    : p.proposedBrief
                    ? "Approve content & plan"
                    : "Approve content"}
                </button>
              </>
            )}
            {pendingVisualTargets.length > 0 && (
              <div className="revision-composition">
                <p>
                  {p.outlineApproved
                    ? "The revised slide is approved. Only the affected visuals need a new composition quote."
                    : "Review the revised slide and its plan, then renew content approval before composing the affected visual."}
                  {creative &&
                    " Each affected slide has a separate 8-credit composition quote; nothing runs automatically."}
                </p>
                {pendingVisualTargets.map((target) => (
                  <button
                    key={target}
                    className="button secondary full-width"
                    disabled={blocked || !p.outlineApproved}
                    onClick={() =>
                      void onQuote("revise", `Compose approved slide ${target}`)
                    }
                  >
                    Review slide {target} composition
                    {creative ? " · 8 credits" : ""}
                    <ArrowRight size={16} />
                  </button>
                ))}
              </div>
            )}
            {p.outlineApproved &&
              !hasCover &&
              !ready &&
              !failed &&
              pendingVisualTargets.length === 0 && (
                <>
                  <p>
                    The story is approved. Next, make one cover to agree on the
                    style.
                  </p>
                  <button
                    className="button primary full-width"
                    disabled={blocked}
                    onClick={() => void onQuote("cover")}
                  >
                    Review cover quote
                    <ArrowRight size={16} />
                  </button>
                </>
              )}
            {p.status === "cover_approval" &&
              p.outlineApproved &&
              hasCover &&
              !p.coverApproved &&
              !failed &&
              pendingVisualTargets.length === 0 && (
                <>
                  <p>
                    Does this look feel right? Approve it or request a change in
                    chat.
                  </p>
                  <button
                    className="button primary full-width"
                    disabled={blocked || slideIndex !== 0}
                    onClick={() => onApprove("cover")}
                  >
                    <Check size={17} />
                    Approve cover & style
                  </button>
                  {slideIndex !== 0 && (
                    <button
                      className="text-button full-width"
                      onClick={() => setSlideIndex(0)}
                    >
                      View the cover before approving
                    </button>
                  )}
                </>
              )}
            {p.coverApproved &&
              !ready &&
              p.slideCount > 1 &&
              !failed &&
              pendingVisualTargets.length === 0 && (
                <>
                  <p>
                    We’ll keep this cover and use its style for the remaining{" "}
                    {p.slideCount - 1} slides.
                  </p>
                  <button
                    className="button primary full-width"
                    disabled={blocked}
                    onClick={() => void onQuote("remaining")}
                  >
                    Review remaining slides quote
                    <ArrowRight size={16} />
                  </button>
                </>
              )}
            {(ready ||
              (failed &&
                p.slides.length > 0 &&
                p.slides.every((item) => item.assetId))) && (
              <>
                {!ready && (
                  <div className="ready-heading">
                    <Check size={18} />
                    <strong>
                      {ready
                        ? "Your post is ready."
                        : "Your previous output is preserved."}
                    </strong>
                    <span>No credits for downloads</span>
                  </div>
                )}
                {!ready && exportActions}
                <button className="text-button next-post" onClick={onNew}>
                  Create the next post
                  <ArrowRight size={15} />
                </button>
              </>
            )}
            <button className="text-button allowance-link" onClick={onBilling}>
              View your credit allowance
            </button>
          </div>
          <CostDetails cost={p.cost} />
          {p.history.length > 0 && (
            <details className="version-history">
              <summary>
                <Clock3 size={15} />
                Saved versions · {p.history.length}
              </summary>
              <ul>
                {p.history.map((entry) => (
                  <li key={entry.version}>
                    <div>
                      <strong>
                        v{entry.version} · {entry.label}
                      </strong>
                      <span>{displayDate(entry.createdAt)}</span>
                      <OriginBadge origin={entry.origin} />
                      <CostDetails cost={entry.cost} />
                    </div>
                    <div className="version-downloads">
                      {entry.canExportImages && (
                        <a
                          href={
                            exportBase +
                            (p.slideCount === 1 ? "png" : "zip") +
                            "&version=" +
                            entry.version
                          }
                          download
                          aria-label={
                            "Download images for version " + entry.version
                          }
                        >
                          <ArrowDownToLine size={13} />
                          {p.slideCount === 1 ? "PNG" : "Images"}
                        </a>
                      )}
                      {entry.canExportImages &&
                        p.platform === "linkedin" &&
                        p.slideCount > 1 && (
                          <a
                            href={exportBase + "pdf&version=" + entry.version}
                            download
                            aria-label={
                              "Download PDF for version " + entry.version
                            }
                          >
                            PDF
                          </a>
                        )}
                      {entry.canExportCaption && (
                        <a
                          href={exportBase + "caption&version=" + entry.version}
                          download
                          aria-label={
                            "Download caption for version " + entry.version
                          }
                        >
                          Caption
                        </a>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
              <p className="field-hint">
                Downloads appear only when the saved version has a complete
                image set or caption. Downloading never runs generation.
              </p>
            </details>
          )}
        </section>
      </div>
    </section>
  );
}

function SavedImageViewer({
  slide,
  assetId,
  direction,
  language,
}: {
  slide: PublicationView["slides"][number];
  assetId: string;
  direction?: PublicationView["artDirection"];
  language: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [actualSize, setActualSize] = useState(false);
  function setSize(actual: boolean) {
    setActualSize(actual);
    requestAnimationFrame(() =>
      stage.current?.scrollTo({ top: 0, left: 0, behavior: "instant" }),
    );
  }
  function open() {
    setSize(false);
    dialog.current?.showModal();
  }
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="text-button full-size-link"
        onClick={open}
        aria-label={"View slide " + (slide.index + 1) + " image at full size"}
      >
        <Maximize2 size={14} /> Full size
      </button>
      <dialog
        ref={dialog}
        className="saved-image-dialog"
        aria-labelledby={titleId}
        onCancel={(event) => {
          event.preventDefault();
          dialog.current?.close();
        }}
        onClose={() => {
          setActualSize(false);
          requestAnimationFrame(() => trigger.current?.focus());
        }}
      >
        <header className="image-viewer-header">
          <h2 id={titleId}>Image preview · slide {slide.index + 1}</h2>
          <div role="group" aria-label="Image scale">
            <button
              type="button"
              aria-pressed={!actualSize}
              onClick={() => setSize(false)}
            >
              Fit
            </button>
            <button
              type="button"
              aria-pressed={actualSize}
              onClick={() => setSize(true)}
            >
              100%
            </button>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close image preview"
            autoFocus
            onClick={() => dialog.current?.close()}
          >
            <X size={20} />
          </button>
        </header>
        <div
          ref={stage}
          className={"image-viewer-stage" + (actualSize ? " actual-size" : "")}
          tabIndex={0}
          role="region"
          aria-label={
            actualSize
              ? "Saved image at 100 percent. Scroll to inspect the full image."
              : "Complete saved image fitted to the viewer."
          }
        >
          <Image
            src={"/api/kely/assets/" + encodeURIComponent(assetId)}
            alt={
              savedSlideDescription(slide, direction)
            }
            lang={language}
            width={1080}
            height={1350}
            unoptimized
          />
        </div>
        <footer className="image-viewer-footer">
          <OriginBadge
            origin={slide.copyOrigin}
            visual={slide.visualOrigin ?? "fixture"}
          />
          <span>Saved image · viewing never generates or edits</span>
        </footer>
      </dialog>
    </>
  );
}

function historyTitle(p: PublicationView) {
  const title = (p.slides[0]?.title || p.idea || p.title).trim();
  if (title.length <= 96) return title;
  const boundary = title.slice(0, 96).lastIndexOf(" ");
  return boundary > 0 ? title.slice(0, boundary) + "…" : title;
}

export function History({
  publications,
  onOpen,
  onNew,
}: {
  publications: PublicationView[];
  onOpen: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <section className="history-section">
      <div className="page-heading">
        <div>
          <span className="eyebrow">YOUR IDEAS, ALL HERE</span>
          <h1>Your posts.</h1>
          <p className="muted">
            Every idea, draft, and finished post in one place.
          </p>
        </div>
        <button className="button primary" onClick={onNew}>
          New post
          <ArrowRight size={16} />
        </button>
      </div>
      {publications.length ? (
        <div className="history-grid">
          {publications.map((p) => (
            <button
              className="history-card"
              key={p.id}
              aria-label={`Open ${historyTitle(p)}, ${statusLabels[p.status]}`}
              onClick={() => onOpen(p.id)}
            >
              <div className={"history-art history-" + p.platform} aria-hidden="true">
                {p.slides[0]?.assetId ? (
                  <Image
                    src={
                      "/api/kely/assets/" +
                      encodeURIComponent(p.slides[0].assetId)
                    }
                    alt=""
                    width={360}
                    height={450}
                    unoptimized
                  />
                ) : (
                  <>
                    <span>{p.platform === "linkedin" ? "in" : "ig"}</span>
                    <span className="history-art-title" dir="auto">{historyTitle(p)}</span>
                    <PencilLine size={26} />
                  </>
                )}
              </div>
              <div className="history-card-copy">
                <span className="small-label">
                  {p.platform} · {p.slideCount}{" "}
                  {p.slideCount === 1 ? "IMAGE" : "SLIDES"}
                </span>
                <h2 dir="auto" lang={publicationLanguage(p.language)}>{historyTitle(p)}</h2>
                <OriginBadge origin={p.origin} />
                <div>
                  <span>{statusLabels[p.status]}</span>
                  <ArrowRight size={17} />
                </div>
                <time dateTime={p.updatedAt}>{displayDate(p.updatedAt)}</time>
              </div>
            </button>
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <FileText size={36} strokeWidth={1.2} />
          <h2>Your first story belongs here.</h2>
          <p>
            Start a post and we’ll keep your progress, approvals, and results
            together.
          </p>
          <button className="button secondary" onClick={onNew}>
            Start a post
            <ArrowRight size={16} />
          </button>
        </div>
      )}
    </section>
  );
}

export function BusinessProfile({
  business,
  busy,
  onSave,
  embedded = false,
}: {
  business: BusinessView | null;
  busy: boolean;
  onSave: (value: { name: string; context: string; website: string }) => void;
  embedded?: boolean;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    onSave({
      name: String(data.get("name")),
      context: String(data.get("context")),
      website: String(data.get("website")),
    });
  }
  return (
    <section className="business-section">
      {!embedded && (
        <span className="eyebrow">A LITTLE CONTEXT GOES A LONG WAY</span>
      )}
      {embedded ? (
        <h2>Your business, in your words.</h2>
      ) : (
        <h1>Your business, in your words.</h1>
      )}
      <p className="section-description">
        You don’t need a perfect brief. Add what feels useful, and pick up from
        here next time.
      </p>
      <form
        className="business-form"
        key={business?.id ?? "new"}
        onSubmit={submit}
      >
        <label>
          Business name
          <input
            name="name"
            required
            maxLength={100}
            defaultValue={business?.name}
            placeholder="The Little Corner"
          />
        </label>
        <label>
          Website <span>optional</span>
          <input
            name="website"
            type="url"
            maxLength={2000}
            defaultValue={business?.website}
            placeholder="https://your-business.com"
          />
          <small>
            Saved as context only. Kely does not visit or independently verify
            your website in this local milestone.
          </small>
        </label>
        <label>
          What should Kely know? <span>optional</span>
          <textarea
            name="context"
            rows={7}
            maxLength={6000}
            defaultValue={business?.context}
            placeholder="What you do, who it’s for, how you like to sound, or anything we shouldn’t say…"
          />
        </label>
        <button className="button primary" disabled={busy}>
          {busy ? "Saving…" : "Save business context"}
          <Check size={16} />
        </button>
        <p className="field-hint">
          One business per account. Your input is treated as a user statement,
          not independently verified fact.
        </p>
      </form>
    </section>
  );
}

export function QuoteDialog({
  quote,
  completeResult = false,
  account,
  busy,
  error,
  errorCode,
  onClose,
  onAccept,
  onBilling,
}: {
  quote: QuoteView;
  completeResult?: boolean;
  account: AccountView;
  busy: boolean;
  error?: string;
  errorCode?: string;
  onClose: () => void;
  onAccept: () => void;
  onBilling: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const balance =
    account.billing.weeklyRemaining + account.billing.packRemaining;
  const enough = balance >= quote.credits;
  const coordinatorBlocked = [
    "budget_exhausted",
    "budget_integrity",
    "package_paused",
    "attempt_uncertain",
  ].includes(errorCode ?? "");
  useEffect(() => {
    const element = dialog.current;
    returnFocus.current =
      document.activeElement instanceof HTMLElement &&
      document.activeElement !== document.body &&
      document.activeElement !== document.documentElement
        ? document.activeElement
        : null;
    element?.showModal();
    return () => {
      element?.close();
    };
  }, []);
  function dismiss() {
    onClose();
    requestAnimationFrame(() => {
      const revisionTrigger =
        quote.kind === "revise" && quote.scope?.kind !== "compose"
          ? document.getElementById("post-message-submit")
          : null;
      const target =
        revisionTrigger ??
        (returnFocus.current?.isConnected &&
        !returnFocus.current.matches(":disabled")
          ? returnFocus.current
          : null);
      if (target && !target.matches(":disabled")) target.focus();
    });
  }
  return (
    <dialog
      className="quote-dialog"
      ref={dialog}
      aria-labelledby="quote-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) dismiss();
      }}
    >
      <div className="quote-dialog-top">
        <KelyLogo small />
        <button
          className="icon-button"
          aria-label="Close quote"
          disabled={busy}
          onClick={dismiss}
        >
          <X size={20} />
        </button>
      </div>
      {!completeResult && <span className="eyebrow">YOU’RE IN CONTROL</span>}
      <h2 id="quote-title">{completeResult ? "Make this change?" : "Ready when you are."}</h2>
      <p>{quote.summary}</p>
      <div className="quote-decision">
        <div>
          <span>Action</span>
          <strong>{quote.credits} credits</strong>
        </div>
        <div>
          <span>Balance after</span>
          <strong>{enough ? balance - quote.credits : "Not enough"}</strong>
        </div>
      </div>
      <details className="quote-includes">
        <summary>What this includes</summary>
        {completeResult ? <><p>The change and its finished visual are included. Other slides and your caption stay unchanged.</p><p>You pay once for the completed change. Previous versions remain available.</p></> : <>
        <OriginBadge origin={quote.origin} />
        {quote.brand && (
          <div className="quote-brand">
          <strong>
            Brand v{quote.brand.version}
            {quote.brand.artDirection ? (
              " · custom visual direction"
            ) : (
              <>
                {" "}
                ·{" "}
                {paletteOptions.find(
                  (item) => item.value === quote.brand!.palette,
                )?.label ?? quote.brand.palette}{" "}
                palette
              </>
            )}
          </strong>
          {quote.brand.artDirection && (
            <>
              <DirectionSummary direction={quote.brand.artDirection} />
              <div className="quote-role-colors">
                {Object.entries(quote.brand.artDirection.palette).map(
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
            </>
          )}
          <p>{quote.brand.notice}</p>
          <BrandCapabilities compact />
          </div>
        )}
        {quote.scope && (
          <div className="quote-scope">
          <strong>
            Slide {quote.scope.target} only ·{" "}
            {quote.scope.kind === "copy"
              ? "Copy revision"
              : quote.scope.kind === "plan"
                ? "Visual plan proposal"
                : quote.scope.kind === "style"
                  ? "Palette-only style revision"
                  : "Approved-slide composition"}
          </strong>
          <p>
            {quote.scope.kind === "copy"
              ? "Changed copy needs renewed content approval, followed by a separate quote for the affected visual. Other slides stay unchanged."
              : quote.scope.kind === "plan"
                ? "3 credits now proposes this slide’s visual plan only. Copy, caption, other slides, font, and palette stay unchanged. After you approve the proposed plan, composing this slide needs a separate 8-credit quote: 11 credits total if you accept both steps. Nothing composes automatically."
                : "Approved wording stays unchanged. This quote affects only the named slide."}
          </p>
          </div>
        )}
        <dl className="quote-details">
          <div><dt>Available now</dt><dd>{balance} credits</dd></div>
          <div><dt>Quote valid until</dt><dd>{displayDate(quote.expiresAt)}</dd></div>
          <div><dt>Bound to saved version</dt><dd>v{quote.version}</dd></div>
        </dl>
        {quote.model && (
          <p className="quote-technical-copy">
            {quote.model} · {originLabel(quote.origin)} · saved version {quote.version}
          </p>
        )}
        {quote.preparation && (
          <div className="preparation-package">
            <strong>
              {quote.preparation.included
                ? "A reply from your active package"
                : `Up to ${quote.preparation.maximumReplies} usable preparation replies`}
            </strong>
            <p>
              {quote.preparation.repliesRemaining} replies available before this action. {quote.preparation.activatesOnFirstUsableReply
                ? "Credits are reserved now; the package activates and is charged only after the first usable reply is saved."
                : "This included reply adds no customer credit charge."}
            </p>
            <p>
              At most four attempts, including one explicit retry after a known failure. Failures keep unused reply slots; uncertain outcomes pause for reconciliation. Content approval closes preparation.
            </p>
          </div>
        )}
        <p className="inline-note">
          {originExplanation(quote.origin)} {quote.kind !== "prepare" && "Credits are reserved first and captured for delivered work. "}
          Billing is simulated. Existing versions are preserved.
        </p>
        </>}
      </details>
      {error && (
        <p className="warning-note" role="alert">
          {error}
        </p>
      )}
      {coordinatorBlocked ? (
        <p className="warning-note">
          Generation is temporarily unavailable. Your work is saved, and buying more credits will not resolve this issue.
        </p>
      ) : enough ? (
        <button
          className="button primary full-width"
          disabled={busy}
          onClick={onAccept}
        >
          {busy
            ? "Starting…"
            : "Confirm · " + quote.credits + " credits"}
          <ArrowRight size={17} />
        </button>
      ) : (
        <>
          <p className="warning-note">
            You don’t have enough credits for this action. Nothing has started.
          </p>
          <button className="button primary full-width" onClick={onBilling}>
            View upgrade options
            <ArrowRight size={17} />
          </button>
        </>
      )}
      <button
        className="text-button full-width quote-cancel"
        disabled={busy}
        onClick={dismiss}
      >
        Not now
      </button>
    </dialog>
  );
}
