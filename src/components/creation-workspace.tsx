"use client";

import { ArrowDownToLine, ArrowLeft, ArrowRight, Send, Sparkles, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { BrandView } from "../shared/brand";
import type { BrandIntelligenceSnapshot, ResearchQuestion, ResearchStage } from "../shared/brand-intelligence";
import type { PublicationView } from "../shared/contracts";
import type { Draft } from "./marketing";
import { request, uploadRaster } from "./api";
import { useBrandData, type RunBrandAction } from "./brand-data";
import { PreferenceSuggestions, type PreferenceConfirmation } from "./preference-suggestions";

type IntakeProps = {
  draft: Draft; ownerId: string; busy: boolean; run: RunBrandAction; onError: (error: unknown) => void; businessName?: string; businessWebsite?: string;
  onBack: () => void; onContinue: (input: { materialIds: string[]; context: string; researchId: string; researchSnapshotHash: string; brandProfileVersion: number }) => Promise<boolean>;
};

type ResearchRunView = {
  id: string;
  status: ResearchStage;
  statusDetail: unknown;
  sources: { id: string }[];
  snapshots: { id: string; version: number; hash: string; value: BrandIntelligenceSnapshot; acceptedAt: string }[];
  researchMode?: string;
  simulated?: boolean;
  notice?: string;
};

const researchStageLabels: Record<ResearchStage, string> = {
  queued: "Research is queued",
  resolving: "Finding the right business",
  fetching: "Reading available brand sources",
  extracting: "Identifying facts and visual signals",
  strategizing: "Building the strongest direction",
  checking: "Checking the proposed plan",
  review_ready: "Your researched plan is ready",
  needs_input: "Kely needs one detail",
  partial: "Research completed with limited sources",
  failed: "Research could not be completed",
  uncertain: "Research outcome is being checked",
};

export function BrandResearchProgress({ stage, detail, sourceCount }: { stage: ResearchStage; detail?: string; sourceCount?: number }) {
  const active = !["review_ready", "needs_input", "partial", "failed", "uncertain"].includes(stage);
  return <section className="brand-research-progress" role="status" aria-live="polite" aria-busy={active}>
    <Sparkles size={24} aria-hidden="true" />
    <div><h2>{researchStageLabels[stage]}</h2>{detail && <p>{detail}</p>}{typeof sourceCount === "number" && <p className="field-hint">{sourceCount} {sourceCount === 1 ? "source" : "sources"} found</p>}</div>
  </section>;
}

export function CreationIntake(props: IntakeProps) {
  return <SavedCreationIntake key={props.draft.idea.trim()} {...props} />;
}

function validResearchUrl(value: string) {
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}

function SavedCreationIntake({ draft, ownerId, busy, run, onError, onBack, onContinue, businessName: savedBusinessName = "", businessWebsite = "" }: IntakeProps) {
  const data = useBrandData(onError, run);
  const [businessName, setBusinessName] = useState(savedBusinessName);
  const [url, setUrl] = useState("");
  const [links, setLinks] = useState<string[]>(() => validResearchUrl(businessWebsite) ? [businessWebsite] : []);
  const [constraints, setConstraints] = useState("");
  const [role, setRole] = useState<"original" | "reference">("reference");
  const [note, setNote] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [research, setResearch] = useState<ResearchRunView | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [quoteFailed, setQuoteFailed] = useState(false);
  const [restored, setRestored] = useState(false);
  const storageKey = "kely:intake:v2:" + ownerId + ":" + draft.idea.trim();
  const researchStorageKey = "kely:research:v1:" + ownerId + ":" + draft.idea.trim();
  const fileKeys = useRef(new WeakMap<File, string>());
  const researchCommandKey = useRef("");
  const completedResearch = useRef<string | null>(null);
  const quotingResearch = useRef<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
      if (saved && typeof saved === "object" && !Array.isArray(saved)) {
        if (typeof saved.businessName === "string") setBusinessName(saved.businessName.slice(0, 160));
        if (typeof saved.url === "string") setUrl(saved.url.slice(0, 2048));
        if (Array.isArray(saved.links)) setLinks([...new Set<string>(saved.links.filter((item: unknown) => typeof item === "string" && validResearchUrl(item)))].slice(0, 5));
        const savedConstraints = typeof saved.constraints === "string" ? saved.constraints.trim() : "";
        const savedContext = typeof saved.context === "string" ? saved.context.trim() : "";
        setConstraints([savedConstraints, savedContext].filter(Boolean).join("\n").slice(0, 1800));
        if (saved.role === "original" || saved.role === "reference") setRole(saved.role);
        if (Array.isArray(saved.selected)) setSelected([...new Set<string>(saved.selected.filter((id: unknown) => typeof id === "string" && /^[a-f\d-]{36}$/i.test(id)))].slice(0, 3));
      }
    } catch {}
    setRestored(true);
  }, [storageKey]);

  useEffect(() => {
    if (!restored || !data.brand) return;
    const available = new Set(data.brand.materials.filter(item => item.kind === "image").map(item => item.id));
    setSelected(ids => {
      const next = ids.filter(id => available.has(id));
      return next.length === ids.length ? ids : next;
    });
  }, [restored, data.brand]);

  useEffect(() => {
    if (!restored) return;
    try { sessionStorage.setItem(storageKey, JSON.stringify({ businessName, url, links, constraints, role, selected })); } catch {}
  }, [restored, storageKey, businessName, url, links, constraints, role, selected]);

  useEffect(() => {
    let active = true;
    try {
      const savedId = sessionStorage.getItem(researchStorageKey);
      researchCommandKey.current = sessionStorage.getItem(researchStorageKey + ":command") ?? "";
      if (savedId && /^[a-f\d-]{36}$/iu.test(savedId)) void request<ResearchRunView>("/api/kely/research/" + encodeURIComponent(savedId)).then(next => { if (active) setResearch(next); }, failure => { if (active) onError(failure); });
    } catch {}
    return () => { active = false; };
  }, [onError, researchStorageKey]);

  useEffect(() => {
    if (!research || !["queued", "resolving", "fetching", "extracting", "strategizing", "checking"].includes(research.status)) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await request<ResearchRunView>("/api/kely/research/" + encodeURIComponent(research!.id));
        if (!active) return;
        setResearch(next);
        if (["queued", "resolving", "fetching", "extracting", "strategizing", "checking"].includes(next.status)) timer = setTimeout(() => void poll(), 1500);
      } catch (failure) { if (active) onError(failure); }
    }
    timer = setTimeout(() => void poll(), 1500);
    return () => { active = false; clearTimeout(timer); };
  }, [onError, research?.id, research?.status]);

  useEffect(() => {
    if (research?.status !== "review_ready" || completedResearch.current === research.id || quotingResearch.current === research.id || !data.brand) return;
    void continueWithResearch();
  }, [constraints, data.brand, onContinue, research, selected]);

  async function continueWithResearch() {
    if (research?.status !== "review_ready" || quotingResearch.current === research.id || !data.brand) return;
    const snapshot = research.snapshots.at(-1);
    if (!snapshot) return;
    quotingResearch.current = research.id;
    const success = await onContinue({ materialIds: selected.filter(id => data.brand?.materials.some(item => item.id === id)), context: constraints.trim() ? `Must include or avoid: ${constraints.trim()}` : "", researchId: research.id, researchSnapshotHash: snapshot.hash, brandProfileVersion: data.brand.version });
    quotingResearch.current = null;
    completedResearch.current = research.id;
    setQuoteFailed(!success);
  }

  async function upload(file: File) {
    if (!data.brand) return;
    let key = fileKeys.current.get(file);
    if (!key) { key = crypto.randomUUID(); fileKeys.current.set(file, key); }
    const query = new URLSearchParams({ role, label: file.name.slice(0, 100), version: String(data.brand.version), commandKey: key });
    await data.change(async () => {
      const next = await uploadRaster<BrandView>("/api/kely/brand/upload?" + query, file);
      const previous = new Set(data.brand!.materials.map(item => item.id));
      setSelected(ids => [...new Set([...ids, ...next.materials.filter(item => !previous.has(item.id)).map(item => item.id)])].slice(0, 3));
      setNote("Added to your brand.");
      return next;
    });
    if (input.current) input.current.value = "";
  }

  function addLink(event: FormEvent) {
    event.preventDefault();
    if (!url.trim()) return;
    try {
      const parsed = new URL(url.trim());
      if (parsed.protocol !== "https:") throw new Error("Use a public HTTPS link.");
      const normalized = parsed.toString();
      setLinks(items => [...new Set([...items, normalized])].slice(0, 5));
      setUrl("");
      setNote("Link added for research.");
    } catch (failure) { onError(failure); }
  }

  async function startResearch() {
    if (!data.brand || !businessName.trim()) return;
    await run(async () => {
      if (!researchCommandKey.current) researchCommandKey.current = crypto.randomUUID();
      try { sessionStorage.setItem(researchStorageKey + ":command", researchCommandKey.current); } catch {}
      const next = await request<ResearchRunView>("/api/kely/research", { businessName: businessName.trim(), idea: draft.idea.trim(), platform: draft.platform, userSuppliedUrls: links, materialIds: selected.filter(id => images.some(item => item.id === id)), commandKey: researchCommandKey.current });
      setResearch(next);
      try { sessionStorage.setItem(researchStorageKey, next.id); } catch {}
    });
  }

  async function answerResearch(questions: ResearchQuestion[]) {
    if (!research) return;
    const response = questions.map(question => ({ code: question.code, key: question.key, value: answers[question.key]?.trim() ?? "" })).filter(item => item.value);
    if (response.length !== questions.length) return;
    await run(async () => {
      const next = await request<ResearchRunView>(`/api/kely/research/${research.id}/answer`, { commandKey: crypto.randomUUID(), answers: response });
      setAnswers({}); setResearch(next);
      try { sessionStorage.setItem(researchStorageKey, next.id); } catch {}
    });
  }

  function resetResearch() {
    setResearch(null); setAnswers({}); setQuoteFailed(false); researchCommandKey.current = "";
    try { sessionStorage.removeItem(researchStorageKey); sessionStorage.removeItem(researchStorageKey + ":command"); } catch {}
  }

  if (research) {
    const detail = research.statusDetail && typeof research.statusDetail === "object" ? research.statusDetail as Record<string, unknown> : {};
    const questions = Array.isArray(detail.questions) ? detail.questions.filter((item): item is ResearchQuestion => Boolean(item && typeof item === "object" && typeof item.prompt === "string" && typeof item.key === "string" && ["entity_conflict", "missing_fact", "missing_asset", "regulated_ambiguity", "offer_ambiguity", "source_conflict"].includes(item.code))) : [];
    const fallback: ResearchQuestion = { code: "entity_conflict", key: "business_identity", prompt: typeof detail.reason === "string" ? detail.reason : "Please confirm the business identity Kely should use." };
    const visibleQuestions = questions.length ? questions.slice(0, 3) : [fallback];
    const complete = visibleQuestions.every(question => answers[question.key]?.trim());
    return <section className="creation-intake research-intake-state">
      <button className="text-button" onClick={onBack} disabled={busy}><ArrowLeft size={16} />Your idea</button>
      <BrandResearchProgress stage={research.status} detail={research.notice ?? (typeof detail.message === "string" ? detail.message : undefined)} sourceCount={research.sources.length} />
      {research.status === "review_ready" && quoteFailed && <><p className="field-hint">The research is ready, but the plan could not be prepared. Your work is saved.</p><button type="button" className="button primary" disabled={busy} onClick={() => { completedResearch.current = null; setQuoteFailed(false); void continueWithResearch(); }}>Prepare the plan again</button></>}
      {research.status === "needs_input" && <form className="research-answer" onSubmit={event => { event.preventDefault(); void answerResearch(visibleQuestions); }}>{visibleQuestions.map((question, index) => <div key={`${question.code}:${question.key}`}><label htmlFor={`research-answer-${index}`}>{question.prompt}</label><textarea id={`research-answer-${index}`} rows={3} maxLength={1000} value={answers[question.key] ?? ""} onChange={event => setAnswers(values => ({ ...values, [question.key]: event.target.value }))} disabled={busy} /></div>)}<button className="button primary" disabled={busy || !complete}>Continue<ArrowRight size={18} /></button></form>}
      {research.status === "partial" && <p className="field-hint">Kely found limited evidence. Add a correction or source before continuing.</p>}
      {(research.status === "partial" || research.status === "failed") && <button type="button" className="button secondary" disabled={busy} onClick={resetResearch}>Edit sources and try again</button>}
      {(research.status === "failed" || research.status === "uncertain") && <p className="field-hint">Your research record is saved. It will not be retried automatically.</p>}
    </section>;
  }

  const images = data.brand?.materials.filter(item => item.kind === "image") ?? [];
  return <section className="creation-intake">
    <button className="text-button" onClick={onBack} disabled={busy}><ArrowLeft size={16} />Your idea</button>
    <h1>Give Kely a starting point.</h1>
    <p className="section-description">Everything below is optional. Kely will research your business, make the professional choices and ask only when something essential is missing.</p>
    <div className="creation-research-inputs">
      <div className="creation-source-form creation-business-name"><div><label htmlFor="creation-business-name">Business or product name</label><p className="field-hint">Kely uses this to find the right company.</p></div><input id="creation-business-name" value={businessName} maxLength={160} onChange={event => setBusinessName(event.target.value)} required disabled={busy} /></div>
      <form onSubmit={addLink} className="creation-source-form creation-link-form">
        <div><label htmlFor="creation-link">Website or social link <span className="field-hint">Optional</span></label><p className="field-hint">Add an official site, profile or post. You can add more than one.</p></div>
        <div className="creation-link-row"><input id="creation-link" type="url" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://…" required disabled={busy} /><button className="button secondary" disabled={busy || data.loading || !url.trim()}>Add link</button></div>
      </form>
      {links.length > 0 && <ul className="creation-research-links" aria-label="Links added for research">{links.map(item => <li key={item}><span>{item}</span><button type="button" className="text-button" aria-label={`Remove ${item}`} disabled={busy} onClick={() => setLinks(items => items.filter(link => link !== item))}>Remove</button></li>)}</ul>}
      <div className="creation-source-form">
        <div><label htmlFor="creation-material-role">Images and brand materials <span className="field-hint">Optional</span></label><p className="field-hint">Logos, product images and screenshots can be used exactly. Past posts can guide the visual style.</p></div>
        <select id="creation-material-role" value={role} onChange={event => setRole(event.target.value as typeof role)} disabled={busy} aria-label="How Kely should use the next uploaded image"><option value="reference">Use as a style reference</option><option value="original">Place the actual image in the post</option></select>
        <input ref={input} id="creation-upload" className="creation-file-input" type="file" accept="image/png,image/jpeg" disabled={busy || data.loading} aria-describedby="creation-upload-disclosure" onChange={event => { const file = event.target.files?.[0]; if (file) void upload(file); }} />
        <p id="creation-upload-disclosure" className="creation-ai-disclosure">Uploaded images may be sent to OpenAI for visual analysis and post creation.</p>
      </div>
    </div>
    {note && <p role="status">{note}</p>}
    {images.length > 0 && <details className="creation-upload-list" open={selected.length > 0}><summary>{selected.length ? `${selected.length} images selected` : "Use saved brand images"}</summary><p className="field-hint">Choose up to three images to guide this post.</p><div>{images.map(item => <label key={item.id}><input type="checkbox" checked={selected.includes(item.id)} disabled={busy || (!selected.includes(item.id) && selected.length >= 3)} onChange={event => setSelected(ids => event.target.checked ? [...ids, item.id] : ids.filter(id => id !== item.id))} /><img src={"/api/kely/brand-materials/" + item.id} alt={item.label} width={64} height={64} /><span>{item.label}</span></label>)}</div></details>}
    <div className="creation-constraints">
      <label htmlFor="creation-constraints">Anything Kely must use or avoid? <span className="field-hint">Optional</span></label>
      <textarea id="creation-constraints" rows={3} maxLength={1800} value={constraints} onChange={event => setConstraints(event.target.value)} placeholder="Exact facts, offer terms, required assets or things you dislike…" disabled={busy} />
    </div>
    <button className="button primary" disabled={busy || data.loading || !data.brand || !restored || !businessName.trim()} onClick={() => void startResearch()}>{busy ? "One moment…" : "Research & prepare a plan"}<ArrowRight size={18} /></button>
    <p className="field-hint">Kely will show her sources and assumptions in the plan. Nothing visual is generated until you approve it.</p>
    <details><summary>Your post idea</summary><p dir="auto">{draft.idea}</p></details>
  </section>;
}

function CreationImageViewer({ assetId, description, slideNumber }: { assetId: string; description: string; slideNumber: number }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [actualSize, setActualSize] = useState(false);
  const src = "/api/kely/assets/" + encodeURIComponent(assetId);
  function resize(actual: boolean) {
    setActualSize(actual);
    requestAnimationFrame(() => stage.current?.scrollTo({ top: 0, left: 0, behavior: "instant" }));
  }
  return <>
    <button ref={trigger} type="button" className="text-button" style={{ display: "block", padding: 0, width: "100%" }} aria-label="Open full-size post" onClick={() => { resize(false); dialog.current?.showModal(); }}><img src={src} alt={description} /></button>
    <dialog ref={dialog} className="saved-image-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); dialog.current?.close(); }} onClose={() => { setActualSize(false); requestAnimationFrame(() => trigger.current?.focus()); }}>
      <header className="image-viewer-header">
        <h2 id={titleId}>Slide {slideNumber}</h2>
        <div role="group" aria-label="Image scale"><button type="button" aria-pressed={!actualSize} onClick={() => resize(false)}>Fit</button><button type="button" aria-pressed={actualSize} onClick={() => resize(true)}>100%</button></div>
        <button type="button" className="icon-button" aria-label="Close image preview" autoFocus onClick={() => dialog.current?.close()}><X size={20} /></button>
      </header>
      <div ref={stage} className={"image-viewer-stage" + (actualSize ? " actual-size" : "")} tabIndex={0} role="region" aria-label={actualSize ? "Image at 100 percent. Scroll to inspect." : "Complete image fitted to the viewer."}><img src={src} alt={description} style={actualSize ? { width: "auto", height: "auto" } : undefined} /></div>
    </dialog>
  </>;
}

export function CreationWorkspace({ publication: p, busy, quote, onAccept, onGenerate, onCancel, onReply, onRevise, onNew, run, onError, onConfirmPreference }: {
  publication: PublicationView; busy: boolean; quote: { id: string; credits: number; summary: string } | null;
  onAccept: () => void; onGenerate: () => void; onCancel: () => void; onReply: (message: string) => Promise<boolean>; onRevise: (message: string) => Promise<boolean>; onNew: () => void;
  run: RunBrandAction; onError: (error: unknown) => void;
  onConfirmPreference: (input: PreferenceConfirmation) => Promise<BrandView>;
}) {
  const brandData = useBrandData(onError, run);
  const [message, setMessage] = useState("");
  const [selected, setSelected] = useState(0);
  const state = p.creation;
  const ready = state?.status === "ready";
  const planReady = state?.status === "plan_ready";
  const running = state?.status === "queued" || state?.status === "working";
  useEffect(() => { if (running) setMessage(""); }, [running]);
  const asset = p.slides[selected]?.assetId;
  const exportBase = `/api/kely/publications/${p.id}/export?format=`;
  async function send(event: FormEvent) {
    event.preventDefault();
    const success = await (ready ? onRevise(message) : onReply(message));
    if (success) setMessage("");
  }
  return <section className={"creation-session" + (ready ? " is-ready" : "")}>
    {state?.status === "quoted" && <div className="creation-confirmation">
      <Sparkles size={28} /><h1>Let’s plan your post.</h1>
      <p dir="auto">{p.idea}</p>
      <p>{p.platform === "instagram" ? "Instagram" : "LinkedIn"} · {p.slideCount === 1 ? "Single image" : `${p.slideCount}-slide carousel`}</p>
      <button className="button primary" disabled={busy || !quote} onClick={onAccept}>Let’s plan<ArrowRight size={18} /></button>
      <p className="field-hint">You’ll review the plan before Kely creates your visuals.</p>
      {!quote && <p role="status">Return to your idea to continue.</p>}
    </div>}
    {running && <div className="creation-progress" role="status"><Sparkles size={32} /><h1>{state.phase === "context" || state.phase === "analysis" || state.phase === "plan" ? "Shaping your plan…" : "Designing your post…"}</h1><p>Your progress is saved. You can come back any time.</p></div>}
    {(state?.status === "failed" || state?.status === "paused") && <div className="creation-confirmation" role="status">
      <h1>{state.cancelled ? "Planning stopped." : "We couldn’t finish this post."}</h1>
      <p>{state.cancelled ? "Your idea and conversation are saved. You can start a new post when you’re ready." : state.status === "failed" ? "Your idea is saved. This unfinished post won’t use your allowance." : "Your work is saved. We’re checking this request before it can continue."}</p>
      {(state.status === "failed" || state.cancelled) && <button className="button secondary" onClick={onNew}><ArrowLeft size={16} />{state.cancelled ? "New post" : "Back to your idea"}</button>}
    </div>}
    {(ready || planReady || state?.status === "needs_input") && <div className={ready ? "creation-result" : planReady ? "creation-plan-layout" : "creation-intake"}>
      {planReady && <article className="creation-plan" aria-labelledby="creation-plan-title">
        <header><span className="eyebrow">YOUR POST PLAN</span><h1 id="creation-plan-title">Here’s what I suggest.</h1><p>{p.platform === "instagram" ? "Instagram" : "LinkedIn"} · {p.slideCount === 1 ? "Single image" : `${p.slideCount}-slide carousel`}</p></header>
        <ol className="creation-plan-slides">{p.slides.map((slide, index) => {
          const material = slide.creativePlan?.materialId ? brandData.brand?.materials.find(item => item.id === slide.creativePlan?.materialId) : null;
          return <li key={slide.id}><span className="field-hint">{p.slideCount === 1 ? "Post text" : `Slide ${index + 1}`}</span><h2 dir="auto">{slide.title}</h2><p dir="auto">{slide.body}</p>{slide.creativePlan && <p className="plan-visual"><strong>Visual:</strong> {material ? `Use “${material.label}”` : "Typography-led composition"} · {slide.creativePlan.purpose}</p>}</li>;
        })}</ol>
        <section><h2>Caption</h2><p dir="auto">{p.caption}</p></section>
        <section><h2>Visual direction</h2><p dir="auto">{state.plan?.visualDirection}</p></section>
      </article>}
      {ready && <div className="creation-artwork">{asset && <CreationImageViewer key={asset} assetId={asset} description={`${p.slides[selected].title}. ${p.slides[selected].body}`} slideNumber={selected + 1} />}<div className="creation-thumbnails" aria-label="Post slides">{p.slides.length > 1 && p.slides.map((slide, index) => <button key={slide.id} aria-label={`Show slide ${index + 1}`} aria-pressed={selected === index} onClick={() => setSelected(index)}>{slide.assetId && <img src={"/api/kely/assets/" + slide.assetId} alt="" />}<span>{index + 1}</span></button>)}</div><details className="post-caption"><summary>Post caption</summary><p dir="auto">{p.caption}</p><a className="text-button" href={exportBase + "caption"} download>Download caption</a></details></div>}
      <div className="creation-chat">
        {planReady ? <h2>Happy with the plan?</h2> : <h1>{ready ? "Your post is ready." : "One more thing…"}</h1>}
        {!ready && !planReady && <div role="log" aria-live="polite">{state.questions.map((question, index) => <p key={index} dir="auto">{question}</p>)}</div>}
        {planReady && <><p>Review the text and direction, or tell Kely what to change.</p><button className="button primary" disabled={busy || !state.plan || Boolean(message.trim())} onClick={onGenerate}><Sparkles size={18} />Generate post</button>{message.trim() && <p className="field-hint">Send your changes first, or clear your message to use this plan.</p>}</>}
        {ready && <a className="button primary" href={exportBase + (p.slideCount === 1 ? "png" : "zip")} download><ArrowDownToLine size={18} />Download post</a>}
        {(ready || state.canReply) ? <form onSubmit={event => void send(event)} className="chat-composer"><label htmlFor="creation-message">{ready ? "What would you change?" : planReady ? "Any changes to the plan?" : "Your reply"}</label><textarea id="creation-message" value={message} maxLength={2000} rows={3} onChange={event => setMessage(event.target.value)} disabled={busy} placeholder={ready || planReady ? "Make the headline shorter on slide 1…" : "Tell Kely, or let it decide…"} /><button className="button primary" disabled={busy || !message.trim()}>{ready ? "Make this change" : planReady ? "Update plan" : "Continue"}<Send size={16} /></button></form> : <p role="status">This planning conversation has reached its limit. Your work is saved.{planReady ? " You can still generate the plan above." : " Contact the beta organiser for help."}</p>}
        <details><summary>Conversation</summary>{p.messages.map(item => <div key={item.id} className={"chat-message message-" + item.role}><strong>{item.role === "user" ? "You" : "Kely"}</strong><p dir="auto">{item.text}</p></div>)}</details>
        {!ready && <details><summary>More options</summary><p className="field-hint">Stop this planning session without generating visuals. Your idea and conversation stay saved.</p><button className="text-button" disabled={busy} onClick={onCancel}>Stop planning</button></details>}
        {ready && <PreferenceSuggestions publication={p} data={brandData} disabled={busy} onConfirm={onConfirmPreference} />}
        {ready && <details><summary>More options</summary>{p.platform === "linkedin" && p.slideCount > 1 && <a className="text-button" href={exportBase + "pdf"} download>Download PDF</a>}<button className="text-button" onClick={onNew}>Create another post</button>{p.history.filter(item => item.canExportImages).map(item => <a className="text-button" key={item.version} href={exportBase + `zip&version=${item.version}`} download>Download version {item.version}</a>)}</details>}
      </div>
    </div>}
  </section>;
}
