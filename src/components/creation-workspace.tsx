"use client";

import { ArrowDownToLine, ArrowLeft, ArrowRight, ImagePlus, Link2, Send, Sparkles, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { BrandImportResult, BrandView } from "../shared/brand";
import type { PublicationView } from "../shared/contracts";
import type { Draft } from "./marketing";
import { request, uploadRaster } from "./api";
import { useBrandData, type RunBrandAction } from "./brand-data";
import { PreferenceSuggestions, type PreferenceConfirmation } from "./preference-suggestions";

type IntakeProps = {
  draft: Draft; ownerId: string; busy: boolean; run: RunBrandAction; onError: (error: unknown) => void;
  onBack: () => void; onContinue: (materialIds: string[], context: string) => void;
};

export function CreationIntake(props: IntakeProps) {
  return <SavedCreationIntake key={props.draft.idea.trim()} {...props} />;
}

function SavedCreationIntake({ draft, ownerId, busy, run, onError, onBack, onContinue }: IntakeProps) {
  const data = useBrandData(onError, run);
  const [source, setSource] = useState<"materials" | "link" | "decide" | null>(null);
  const [url, setUrl] = useState("");
  const [context, setContext] = useState("");
  const [audience, setAudience] = useState("");
  const [outcome, setOutcome] = useState("");
  const [constraints, setConstraints] = useState("");
  const [role, setRole] = useState<"original" | "reference">("reference");
  const [note, setNote] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [restored, setRestored] = useState(false);
  const storageKey = "kely:intake:v2:" + ownerId + ":" + draft.idea.trim();
  const fileKeys = useRef(new WeakMap<File, string>());
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
      if (saved && typeof saved === "object" && !Array.isArray(saved)) {
        if (["materials", "link", "decide"].includes(saved.source)) setSource(saved.source);
        if (typeof saved.url === "string") setUrl(saved.url.slice(0, 2048));
        if (typeof saved.context === "string") setContext(saved.context.slice(0, 1800));
        if (typeof saved.audience === "string") setAudience(saved.audience.slice(0, 500));
        if (typeof saved.outcome === "string") setOutcome(saved.outcome.slice(0, 500));
        if (typeof saved.constraints === "string") setConstraints(saved.constraints.slice(0, 800));
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
    try { sessionStorage.setItem(storageKey, JSON.stringify({ source, url, context, audience, outcome, constraints, role, selected })); } catch {}
  }, [restored, storageKey, source, url, context, audience, outcome, constraints, role, selected]);

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

  async function importLink(event: FormEvent) {
    event.preventDefault();
    if (!data.brand || !url.trim()) return;
    await data.change(async () => {
      const values = { label: "Brand reference", sourceUrl: url.trim(), version: data.brand!.version };
      const next = await request<BrandImportResult>("/api/kely/brand/import", { ...values, commandKey: data.commandKey("import", values) });
      setNote(next.outcome.status === "imported" ? "Reference added." : "This link has limited images. Add saved posts or screenshots for a closer match.");
      const previous = new Set(data.brand!.materials.map(item => item.id));
      setSelected(ids => [...new Set([...ids, ...next.brand.materials.filter(item => item.kind === "image" && !previous.has(item.id)).map(item => item.id)])].slice(0, 3));
      return next.brand;
    });
  }

  const images = data.brand?.materials.filter(item => item.kind === "image") ?? [];
  return <section className="creation-intake">
    <button className="text-button" onClick={onBack} disabled={busy}><ArrowLeft size={16} />Your idea</button>
    <h1>Let’s make it yours.</h1>
    <p className="section-description">Give Kely what you have. She’ll ask only for anything essential that’s missing.</p>
    <div className="creation-source-options" role="group" aria-label="Brand starting point">
      {([{ id: "materials", label: "Add materials", icon: ImagePlus }, { id: "link", label: "Paste a link", icon: Link2 }, { id: "decide", label: "Let Kely decide", icon: Sparkles }] as const).map(item => <button key={item.id} type="button" className={source === item.id ? "selected" : ""} aria-pressed={source === item.id} disabled={busy} onClick={() => setSource(item.id)}><item.icon size={22} /><span>{item.label}</span></button>)}
    </div>
    {source === "materials" && <div className="creation-source-form">
      <label htmlFor="creation-material-role">How should Kely use these?</label>
      <select id="creation-material-role" value={role} onChange={event => setRole(event.target.value as typeof role)} disabled={busy}><option value="reference">Learn the visual style</option><option value="original">Place the actual image in the post</option></select>
      <label className="button secondary" htmlFor="creation-upload"><ImagePlus size={18} />Choose an image</label>
      <input ref={input} id="creation-upload" className="sr-only" type="file" accept="image/png,image/jpeg" disabled={busy || data.loading} onChange={event => { const file = event.target.files?.[0]; if (file) void upload(file); }} />
      <p className="field-hint">Upload logos, product screenshots or photos as actual images. Upload past posts as style references.</p>
    </div>}
    {source === "link" && <form onSubmit={event => void importLink(event)} className="creation-source-form"><label htmlFor="creation-link">Website or social post</label><input id="creation-link" type="url" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://…" required disabled={busy} /><button className="button secondary" disabled={busy || data.loading || !url.trim()}>Add reference</button></form>}
    {note && <p role="status">{note}</p>}
    {images.length > 0 && <details className="creation-upload-list" open={selected.length > 0}><summary>{selected.length ? `${selected.length} references selected` : "Use saved brand images"}</summary><p className="field-hint">Choose up to three images to guide this post.</p><div>{images.map(item => <label key={item.id}><input type="checkbox" checked={selected.includes(item.id)} disabled={busy || (!selected.includes(item.id) && selected.length >= 3)} onChange={event => setSelected(ids => event.target.checked ? [...ids, item.id] : ids.filter(id => id !== item.id))} /><img src={"/api/kely/brand-materials/" + item.id} alt={item.label} width={64} height={64} /><span>{item.label}</span></label>)}</div></details>}
    <details className="creation-brief-details">
      <summary>Add useful details <span className="field-hint">Optional</span></summary>
      <div className="creation-brief-grid">
        <label htmlFor="creation-audience">Who is this for?</label>
        <input id="creation-audience" maxLength={500} value={audience} onChange={event => setAudience(event.target.value)} placeholder="You decide, or describe the audience" disabled={busy} />
        <label htmlFor="creation-outcome">What should they do or understand?</label>
        <input id="creation-outcome" maxLength={500} value={outcome} onChange={event => setOutcome(event.target.value)} placeholder="Learn more, book, message us…" disabled={busy} />
        <label htmlFor="creation-constraints">What must be included or avoided?</label>
        <textarea id="creation-constraints" rows={3} maxLength={800} value={constraints} onChange={event => setConstraints(event.target.value)} placeholder="Exact facts, offer terms, CTA, visual dislikes…" disabled={busy} />
        <label htmlFor="creation-preferences">Anything else?</label>
        <textarea id="creation-preferences" rows={3} maxLength={1800} value={context} onChange={event => setContext(event.target.value)} placeholder="Tone, mood, context or leave it to Kely" disabled={busy} />
      </div>
    </details>
    <button className="button primary" disabled={busy || data.loading || !data.brand || !restored} onClick={() => {
      const brief = [audience.trim() && `Audience: ${audience.trim()}`, outcome.trim() && `Desired outcome: ${outcome.trim()}`, constraints.trim() && `Must include or avoid: ${constraints.trim()}`, context.trim() && `Additional context: ${context.trim()}`].filter(Boolean).join("\n");
      onContinue(selected.filter(id => images.some(item => item.id === id)), brief);
    }}>{busy ? "One moment…" : "Let’s plan"}<ArrowRight size={18} /></button>
    <p className="field-hint">Your brand stays saved. You can change it any time.</p>
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
