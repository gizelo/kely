"use client";

import {
  Coins,
  History as HistoryIcon,
  LogOut,
  Plus,
  Palette,
  RefreshCw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AccountView,
  BusinessView,
  OperationKind,
  OperationView,
  PublicationView,
  QuoteView,
} from "../shared/contracts";
import { request, RequestError } from "./api";
import type { CreationQuoteView, CreationResponse } from "../shared/creation";
import { CreationIntake, CreationWorkspace } from "./creation-workspace";
import {
  AuthScreen,
  Brand,
  IdeaForm,
  Landing,
  type Draft,
} from "./marketing";
import {
  BusinessProfile,
  History,
  PublicationWorkspace,
  QuoteDialog,
} from "./workspace";
import { BrandWorkspace } from "./brand-workspace";
import { KelyLogo } from "./identity";
import type { BrandView } from "../shared/brand";

type View =
  | "landing"
  | "auth"
  | "new"
  | "intake"
  | "post"
  | "history"
  | "business"
  | "billing";
const emptyDraft: Draft = { idea: "", platform: "linkedin", slideCount: 0 };
const draftKey = "kely.draft.v1";

function storedDraft(key: string): Draft | null {
  try {
    const stored = JSON.parse(localStorage.getItem(key) ?? "null") as Partial<Draft> | null;
    if (!stored || typeof stored.idea !== "string") return null;
    return {
      idea: stored.idea.slice(0, 2000),
      platform: stored.platform === "instagram" ? "instagram" : "linkedin",
      slideCount: typeof stored.slideCount === "number" && stored.slideCount >= 0 && stored.slideCount <= 6 ? stored.slideCount : 0,
    };
  } catch { return null; }
}

export function KelyApp({
  inviteOnly = false,
  initialView = "landing",
}: {
  inviteOnly?: boolean;
  initialView?: "landing" | "auth";
}) {
  const [account, setAccount] = useState<AccountView | null>(null);
  const [publications, setPublications] = useState<PublicationView[]>([]);
  const [publication, setPublication] = useState<PublicationView | null>(null);
  const [view, setView] = useState<View>(initialView);
  const [authMode, setAuthMode] = useState<"signup" | "signin">(
    inviteOnly ? "signin" : "signup",
  );
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [sourceAnalysisId, setSourceAnalysisId] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(
    null,
  );
  const [notice, setNotice] = useState("");
  const [quote, setQuote] = useState<QuoteView | null>(null);
  const [creationQuote, setCreationQuote] = useState<CreationQuoteView | null>(null);
  const [pollingPaused, setPollingPaused] = useState(false);
  const [resumeDraft, setResumeDraft] = useState(false);
  const acceptingKeys = useRef(new Map<string, string>());
  const actionLock = useRef(false);
  const currentPublicationId = useRef<string | null>(null);
  const billingReturnPostId = useRef<string | null>(null);
  const brandReturnView = useRef<"new" | "post">("new");
  const mainContent = useRef<HTMLElement | null>(null);
  const focusAfterNavigation = useRef(false);

  const focusMain = useCallback(() => {
    requestAnimationFrame(() => {
      const target = mainContent.current ?? document.getElementById("main-content");
      target?.focus();
    });
  }, []);

  const handleError = useCallback((failure: unknown) => {
    if (failure instanceof RequestError && failure.status === 401) {
      setAccount(null);
      billingReturnPostId.current = null;
      setSourceAnalysisId(null);
      setPublication(null);
      setPublications([]);
      setQuote(null);
      setAuthMode("signin");
      focusAfterNavigation.current = true;
      setView("auth");
    }
    setError({
      message:
        failure instanceof Error
          ? failure.message
          : "Something didn’t finish. Your saved work is preserved.",
      code: failure instanceof RequestError ? failure.code : undefined,
    });
  }, []);

  const loadAccount = useCallback(async () => {
    const next = await request<AccountView>("/api/kely/account");
    setAccount(next);
    return next;
  }, []);

  const syncPublication = useCallback((next: PublicationView) => {
    setPublication(next);
    setCreationQuote(next.creation?.quote ?? null);
    setPublications((items) => [
      next,
      ...items.filter((item) => item.id !== next.id),
    ]);
  }, []);

  const loadPublication = useCallback(
    async (id: string) => {
      const next = await request<PublicationView>(
        "/api/kely/publications/" + encodeURIComponent(id),
      );
      if (currentPublicationId.current === id) syncPublication(next);
      return next;
    },
    [syncPublication],
  );

  useEffect(() => {
    let active = true;
    const anonymousDraft = storedDraft(draftKey);
    if (anonymousDraft) setDraft(anonymousDraft);
    void (async () => {
      try {
        const next = await request<AccountView>("/api/kely/account");
        const data = await request<{ publications: PublicationView[] }>(
          "/api/kely/publications",
        );
        if (!active) return;
        setAccount(next);
        const ownerDraft = storedDraft(`${draftKey}.${next.user.id}`);
        if (ownerDraft) setDraft(ownerDraft);
        setPublications(data.publications);
        let savedId: string | null = null;
        try {
          savedId = localStorage.getItem("kely.last-post.v1." + next.user.id);
        } catch {}
        const saved = data.publications.find((item) => item.id === savedId);
        if (saved) {
          currentPublicationId.current = saved.id;
          await loadPublication(saved.id);
          if (!active) return;
          setView("post");
        } else setView(next.billing.tier === "none" && next.billing.packRemaining <= 0 ? "billing" : "new");
      } catch (failure) {
        if (
          active &&
          !(failure instanceof RequestError && failure.status === 401)
        )
          handleError(failure);
      } finally {
        if (active) setInitialized(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [handleError, loadPublication]);

  useEffect(() => {
    if (!initialized) return;
    try {
      localStorage.setItem(account ? `${draftKey}.${account.user.id}` : draftKey, JSON.stringify(draft));
    } catch {}
  }, [account, draft, initialized]);

  const operationId = publication?.pendingOperation?.id;
  const operationStatus = publication?.pendingOperation?.status;
  useEffect(() => {
    if (
      !operationId ||
      !publication ||
      pollingPaused ||
      (operationStatus !== "queued" && operationStatus !== "running")
    )
      return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const id = publication.id;
    async function poll() {
      try {
        const [operation, next, nextAccount] = await Promise.all([
          request<OperationView>("/api/kely/operations/" + operationId),
          request<PublicationView>("/api/kely/publications/" + id),
          request<AccountView>("/api/kely/account"),
        ]);
        if (stopped || currentPublicationId.current !== id) return;
        syncPublication(next);
        setAccount(nextAccount);
        if (
          next.pendingOperation?.status === "queued" ||
          next.pendingOperation?.status === "running"
        )
          timer = setTimeout(poll, 1400);
        else if (operation.status === "completed" && !next.creation)
          setNotice("Your saved post has been updated.");
        else if (operation.error && !next.creation)
          setError({ message: operation.error, code: next.failureCode });
      } catch (failure) {
        if (!stopped) {
          setPollingPaused(true);
          handleError(failure);
        }
      }
    }
    timer = setTimeout(poll, 600);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [
    operationId,
    operationStatus,
    publication?.id,
    pollingPaused,
    syncPublication,
    handleError,
  ]);

  async function run(action: () => Promise<void>) {
    if (actionLock.current) return false;
    actionLock.current = true;
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      await action();
      return true;
    } catch (failure) {
      handleError(failure);
      if (
        failure instanceof RequestError &&
        failure.status === 409 &&
        currentPublicationId.current
      ) {
        setQuote(null);
        try {
          await loadPublication(currentPublicationId.current);
        } catch {}
      }
      return false;
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  }

  function navigate(next: View) {
    if (next === "business" && view !== "business" && view !== "billing")
      brandReturnView.current = view === "post" ? "post" : "new";
    focusAfterNavigation.current = next !== view;
    if (next === "billing" && view !== "billing") {
      billingReturnPostId.current =
        view === "post" ? (publication?.id ?? null) : null;
    } else if (next !== "billing") {
      billingReturnPostId.current = null;
    }
    setView(next);
    setError(null);
    setNotice("");
    setQuote(null);
    setCreationQuote(null);
    if (next === "new") {
      setPublication(null);
      currentPublicationId.current = null;
      if (account) {
        try {
          localStorage.removeItem("kely.last-post.v1." + account.user.id);
        } catch {}
      }
    }
  }

  useEffect(() => {
    if (!focusAfterNavigation.current) return;
    focusAfterNavigation.current = false;
    focusMain();
  }, [view, account, focusMain]);

  async function createPost() {
    if (!draft.idea.trim()) return;
    if (!account) {
      setResumeDraft(true);
      setAuthMode(inviteOnly ? "signin" : "signup");
      focusAfterNavigation.current = true;
      setView("auth");
      return;
    }
    const paidAccess =
      account.billing.activeUntil &&
      new Date(account.billing.activeUntil).getTime() > Date.now();
    if (!paidAccess && account.billing.packRemaining <= 0) {
      setResumeDraft(true);
      navigate("billing");
      return;
    }
    navigate("intake");
  }

  async function prepareCreation(materialIds: string[], context: string) {
    if (!account) return;
    await run(async () => {
      const result = await request<{ publication: PublicationView; quote: CreationQuoteView }>("/api/kely/creations/quote", {
        idea: draft.idea.trim(), platform: draft.platform,
        ...(draft.slideCount > 0 ? { slideCount: draft.slideCount } : {}),
        ...(sourceAnalysisId ? { sourceAnalysisId } : {}),
        ...(materialIds.length ? { analysisMaterialIds: materialIds } : {}),
        ...(context.trim() ? { context: context.trim() } : {}),
      });
      const next = result.publication;
      currentPublicationId.current = next.id;
      syncPublication(next);
      setCreationQuote(result.quote);
      focusAfterNavigation.current = true;
      setView("post");
      setPollingPaused(false);
      setResumeDraft(false);
      try {
        localStorage.setItem("kely.last-post.v1." + account.user.id, next.id);
      } catch {}
      setDraft(emptyDraft);
      setSourceAnalysisId(null);
      await acceptCreationQuote(result.quote);
    });
  }

  async function acceptCreationQuote(nextQuote: CreationQuoteView) {
    let requestKey = acceptingKeys.current.get(nextQuote.id);
    if (!requestKey) { requestKey = crypto.randomUUID(); acceptingKeys.current.set(nextQuote.id, requestKey); }
    const result = await request<{ operationId: string; publicationId: string }>("/api/kely/creations/accept", { quoteId: nextQuote.id, requestKey });
    currentPublicationId.current = result.publicationId;
    await Promise.all([loadPublication(result.publicationId), loadAccount()]);
    setCreationQuote(null);
    setPollingPaused(false);
  }

  async function acceptCreation() {
    if (!creationQuote) return;
    await run(() => acceptCreationQuote(creationQuote));
  }

  async function generateCreation() {
    const plan = publication?.creation?.plan;
    if (!publication || !plan) return;
    await run(async () => {
      const signature = `${publication.id}:generate:${plan.version}:${plan.hash}`;
      let requestKey = acceptingKeys.current.get(signature);
      if (!requestKey) { requestKey = crypto.randomUUID(); acceptingKeys.current.set(signature, requestKey); }
      const result = await request<{ operationId: string; publicationId: string }>(`/api/kely/creations/${publication.id}/generate`, { version: publication.version, planVersion: plan.version, planHash: plan.hash, requestKey });
      await Promise.all([loadPublication(result.publicationId), loadAccount()]);
      setPollingPaused(false);
    });
  }

  async function replyToCreation(message: string) {
    if (!publication) return false;
    return run(async () => {
      const signature = `${publication.id}:${publication.version}:${message}`;
      let requestKey = acceptingKeys.current.get(signature);
      if (!requestKey) { requestKey = crypto.randomUUID(); acceptingKeys.current.set(signature, requestKey); }
      const result = await request<{ operationId: string; publicationId: string }>(`/api/kely/creations/${publication.id}/reply`, { message, version: publication.version, requestKey });
      await Promise.all([loadPublication(result.publicationId), loadAccount()]);
      setPollingPaused(false);
    });
  }

  async function cancelCreation() {
    if (!publication) return;
    await run(async () => {
      const result = await request<CreationResponse>(`/api/kely/creations/${publication.id}/cancel`, { version: publication.version });
      syncPublication(result.publication);
      await loadAccount();
    });
  }

  function startFromCreation() {
    if (publication?.creation?.status === "failed") {
      setDraft({ idea: publication.idea, platform: publication.platform, slideCount: publication.slideCount });
    }
    navigate("new");
  }

  async function authenticate(values: {
    name: string;
    email: string;
    password: string;
  }) {
    await run(async () => {
      await request(
        "/api/auth/" +
          (authMode === "signup" ? "sign-up" : "sign-in") +
          "/email",
        values,
      );
      const [next, data] = await Promise.all([
        loadAccount(),
        request<{ publications: PublicationView[] }>("/api/kely/publications"),
      ]);
      setPublications(data.publications);
      focusAfterNavigation.current = true;
      setView(
        next.billing.tier === "none" && next.billing.packRemaining <= 0
          ? "billing"
          : "new",
      );
    });
  }

  async function quoteAction(kind: OperationKind, instruction?: string) {
    if (!publication) return false;
    return run(async () => {
      const next = await request<QuoteView>(
        "/api/kely/publications/" + publication.id + "/quote",
        { kind, instruction, version: publication.version },
      );
      await loadAccount();
      if (publication.creation && kind === "revise") {
        let key = acceptingKeys.current.get(next.id);
        if (!key) { key = crypto.randomUUID(); acceptingKeys.current.set(next.id, key); }
        const result = await request<{ operationId: string; publicationId: string }>("/api/kely/quotes/" + next.id + "/accept", { idempotencyKey: key });
        await Promise.all([loadPublication(result.publicationId), loadAccount()]);
        setPollingPaused(false);
      } else setQuote(next);
    });
  }

  async function acceptQuote() {
    if (!quote) return;
    await run(async () => {
      let key = acceptingKeys.current.get(quote.id);
      if (!key) {
        key = crypto.randomUUID();
        acceptingKeys.current.set(quote.id, key);
      }
      const result = await request<{
        operationId: string;
        publicationId: string;
      }>("/api/kely/quotes/" + quote.id + "/accept", { idempotencyKey: key });
      currentPublicationId.current = result.publicationId;
      await Promise.all([loadPublication(result.publicationId), loadAccount()]);
      setQuote(null);
      setPollingPaused(false);
      setView("post");
      focusMain();
    });
  }

  async function refresh() {
    await run(async () => {
      await Promise.all([
        loadAccount(),
        currentPublicationId.current
          ? loadPublication(currentPublicationId.current)
          : Promise.resolve(),
      ]);
      setPollingPaused(false);
      setNotice("Showing the latest saved state.");
    });
  }

  const notices = (
    <div className="notices">
      {error && (
        <div className="error-banner" role="alert">
          <div>
            <strong>Let’s pause for a moment.</strong>
            <p>{error.message}</p>
            {error.code === "revision_scope_required" && (
              <p>
                Keep your request in the conversation and name one slide plus a
                copy or style change, for example “Shorten the title on slide
                2”. Nothing has been spent.
              </p>
            )}
            {error.code === "budget_exhausted" && (
              <p>
                Generation is temporarily unavailable. Your work is saved;
                please try again when generation is available.
              </p>
            )}
            {account &&
              ["insufficient_credits", "entitlement_required"].includes(
                error.code ?? "",
              ) && (
                <button
                  className="text-button"
                  onClick={() => navigate("billing")}
                >
                  View usage
                </button>
              )}
          </div>
          <button
            className="icon-button"
            aria-label="Dismiss error"
            onClick={() => setError(null)}
          >
            <X size={17} />
          </button>
        </div>
      )}
      {notice && (
        <div className="notice-banner" role="status">
          {notice}
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setNotice("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {account && view !== "billing" && account.billing.weeklyRemaining + account.billing.packRemaining < 30 && !error && <p className="low-usage-notice" role="status">Your allowance is running low. <button className="text-button" onClick={() => navigate("billing")}>View usage</button></p>}
    </div>
  );

  if (!initialized)
    return (
      <>
        <main className="loading-screen">
          <KelyLogo />
          <h1>A little moment…</h1>
          <p>Opening your saved workspace.</p>
        </main>
      </>
    );
  if (!account)
    return (
      <>
        <a className="skip-link" href="#main-content">
          Skip to content
        </a>
        {notices}
        {view === "auth" ? (
          <AuthScreen
            inviteOnly={inviteOnly}
            mode={authMode}
            setMode={setAuthMode}
            busy={busy}
            onSubmit={(values) => void authenticate(values)}
            onBack={() => {
              if (initialView === "auth") window.location.assign("/");
              else navigate("landing");
            }}
          />
        ) : (
          <Landing
            draft={draft}
            onChange={setDraft}
            onStart={() => void createPost()}
            onCreateAccount={() => {
              setAuthMode(inviteOnly ? "signin" : "signup");
              focusAfterNavigation.current = true;
              setView("auth");
            }}
            onSignIn={() => {
              setAuthMode("signin");
              focusAfterNavigation.current = true;
              setView("auth");
            }}
            busy={busy}
          />
        )}
      </>
    );

  const canEditBrand =
    Boolean(
      account.billing.activeUntil &&
        new Date(account.billing.activeUntil).getTime() > Date.now(),
    ) || account.billing.packRemaining > 0;
  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <div className="app-shell bright-studio">
        <aside className="sidebar" aria-label="Kely workspace">
          <Brand onClick={() => navigate("new")} />
          <button
            className="button primary new-post-button"
            onClick={() => navigate("new")}
          >
            <Plus size={18} />
            New post
          </button>
          <nav aria-label="Workspace navigation">
            {(
              [
                { id: "history", label: "Posts", icon: HistoryIcon },
                { id: "business", label: "Brand", icon: Palette },
              ] as const
            ).map((item) => (
              <button
                key={item.id}
                className={view === item.id ? "nav-active" : ""}
                aria-current={view === item.id ? "page" : undefined}
                onClick={() => navigate(item.id)}
              >
                <item.icon size={18} />
                {item.label}
              </button>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <button className="post-balance" onClick={() => navigate("billing")} aria-label="View weekly post allowance">
              <strong>{Math.floor((account.billing.weeklyRemaining + account.billing.packRemaining) / 30)}</strong>
              <span>posts left</span>
            </button>
            <details className="account-menu">
              <summary aria-label="Account menu">
                <span className="avatar">
                  {(account.user.name || account.user.email)
                    .slice(0, 1)
                    .toUpperCase()}
                </span>
                <span className="account-summary-name">
                  {account.user.name || "Your account"}
                </span>
              </summary>
              <div className="account-card">
                <span className="avatar">
                  {(account.user.name || account.user.email)
                    .slice(0, 1)
                    .toUpperCase()}
                </span>
                <div>
                  <strong>{account.user.name || "Your workspace"}</strong>
                  <span>{account.user.email}</span>
                </div>
                <button className="text-button" onClick={() => navigate("billing")}>
                  <Coins size={16} aria-hidden="true" />
                  Usage
                </button>
                <button
                  className="icon-button"
                  aria-label="Log out"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await request("/api/auth/sign-out", {});
                      try {
                        for (const key of Object.keys(sessionStorage)) {
                          if (key.startsWith("kely:intake:")) sessionStorage.removeItem(key);
                        }
                      } catch {}
                      setAccount(null);
                      billingReturnPostId.current = null;
                      setSourceAnalysisId(null);
                      setDraft(emptyDraft);
                      setPublication(null);
                      setPublications([]);
                      currentPublicationId.current = null;
                      if (initialView === "auth") window.location.assign("/");
                      else {
                        focusAfterNavigation.current = true;
                        setView("landing");
                      }
                    })
                  }
                >
                  <LogOut size={16} />
                </button>
                <button
                  className="text-button mobile-workspace-refresh"
                  disabled={busy}
                  onClick={() => void refresh()}
                >
                  <RefreshCw size={14} />
                  Refresh workspace
                </button>
              </div>
            </details>
          </div>
        </aside>
        <div className="app-main">
          {notices}
          <main
            id="main-content"
            className="workspace-main"
            ref={mainContent}
            tabIndex={-1}
            aria-label={
              view === "new" || view === "intake"
                ? "New post"
                : view === "post"
                  ? "Current post"
                  : view === "history"
                    ? "Your posts"
                    : view === "business"
                      ? "Brand"
                      : view === "billing"
                        ? "Usage"
                        : "Kely workspace"
            }
          >
            {view === "new" && (
              <section className="new-post-screen">
                <h1>
                  What’s on your mind
                  {account.user.name
                    ? ", " + account.user.name.split(" ")[0]
                    : ""}
                  ?
                </h1>
                <p className="section-description">
                  Tell Kely what you want to share.
                </p>
                <IdeaForm
                  compact
                  draft={draft}
                  onChange={setDraft}
                  onSubmit={() => void createPost()}
                  busy={busy}
                />
              </section>
            )}
            {view === "intake" && <CreationIntake key={account.user.id} ownerId={account.user.id} draft={draft} busy={busy} run={run} onError={handleError} onBack={() => navigate("new")} onContinue={(materialIds, context) => void prepareCreation(materialIds, context)} />}
            {view === "billing" && (
              <section className="creation-plan beta-usage"><span className="eyebrow">YOUR ACCOUNT</span><h1>{account.billing.tier === "none" && account.billing.packRemaining <= 0 ? "Access isn’t active yet." : "Your weekly allowance"}</h1>{account.billing.tier === "none" && account.billing.packRemaining <= 0 ? <><p>This workspace can save ideas, but creating posts requires beta access.</p><p className="field-hint">Contact the beta organiser if you expected access.</p></> : <><div className="usage-hero"><strong>{Math.floor((account.billing.weeklyRemaining + account.billing.packRemaining) / 30)}</strong><span>posts left this week</span></div><dl><div><dt>In progress</dt><dd>{account.billing.reserved > 0 ? "1 post" : "None"}</dd></div>{account.billing.nextResetAt && <div><dt>Next reset</dt><dd>{new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(account.billing.nextResetAt))}</dd></div>}</dl><p className="field-hint">A post includes planning, generation, and one focused refinement. Your finished posts stay available after the weekly reset.</p></>}<a className="text-button" href="/beta-info">Privacy and data</a></section>
            )}
            {view === "business" && (
              <BrandWorkspace
                key={account.user.id}
                busy={busy}
                canEdit={canEditBrand}
                availableCredits={
                  account.billing.weeklyRemaining +
                  account.billing.packRemaining
                }
                onAccountRefresh={loadAccount}
                run={run}
                onError={handleError}
                onBilling={() => navigate("billing")}
                onContinue={() =>
                  navigate(
                    brandReturnView.current === "post" && publication
                      ? "post"
                      : "new",
                  )
                }
                businessFacts={
                  <BusinessProfile
                    embedded
                    business={account.business}
                    busy={busy || !canEditBrand}
                    onSave={(value) =>
                      void run(async () => {
                        const business = await request<BusinessView>(
                          "/api/kely/business",
                          value,
                        );
                        setAccount({ ...account, business });
                        setNotice(
                          "Your business context is saved for the next post.",
                        );
                      })
                    }
                  />
                }
              />
            )}
            {view === "history" && (
              <History
                publications={publications}
                onNew={() => navigate("new")}
                onOpen={(id) =>
                  void run(async () => {
                    currentPublicationId.current = id;
                    await loadPublication(id);
                    focusAfterNavigation.current = true;
                    setView("post");
                    setPollingPaused(false);
                    try {
                      localStorage.setItem(
                        "kely.last-post.v1." + account.user.id,
                        id,
                      );
                    } catch {}
                  })
                }
              />
            )}
            {view === "post" && publication?.creation && <CreationWorkspace key={publication.id} publication={publication} quote={creationQuote} busy={busy} onAccept={() => void acceptCreation()} onGenerate={() => void generateCreation()} onCancel={() => void cancelCreation()} onReply={replyToCreation} onRevise={message => quoteAction("revise", message)} onNew={startFromCreation} run={run} onError={handleError} onConfirmPreference={async input => {
              const result = await request<{ publication: PublicationView; brand: BrandView }>("/api/kely/publications/" + publication.id + "/preferences", input);
              syncPublication(result.publication);
              setNotice("Remembered for future posts. You can undo this in Brand.");
              return result.brand;
            }} />}
            {view === "post" && publication && !publication.creation && (
              <PublicationWorkspace
                key={publication.id}
                publication={publication}
                busy={busy}
                onNew={() => navigate("new")}
                onBilling={() => navigate("billing")}
                onQuote={quoteAction}
                canEditBrand={canEditBrand}
                run={run}
                onError={handleError}
                onOpenBrand={() => navigate("business")}
                onConfirmPreference={async (input) => {
                  const result = await request<{
                    publication: PublicationView;
                    brand: BrandView;
                  }>(
                    "/api/kely/publications/" + publication.id + "/preferences",
                    input,
                  );
                  syncPublication(result.publication);
                  const finished =
                    result.publication.outlineApproved ||
                    Boolean(result.publication.preparation?.closed);
                  setNotice(
                    input.scope === "durable"
                      ? finished
                        ? "Preference saved to Brand with Undo. This finished post was not changed."
                        : "Preference saved to Brand with Undo. Prepare the current copy again before approval; no reply runs automatically."
                      : "Preference saved only to this post. Prepare the copy again before approval; no reply runs automatically.",
                  );
                  return result.brand;
                }}
                onSaveBrief={(brief) =>
                  run(async () => {
                    const next = await request<PublicationView>(
                      "/api/kely/publications/" + publication.id + "/brief",
                      { ...brief, version: publication.version },
                    );
                    syncPublication(next);
                    setNotice(
                      next.status === "collecting" &&
                        publication.slides.length > 0
                        ? "Brief saved. Prepare and review the copy again before approval; your factual resolution has not silently changed existing wording."
                        : "This post’s brief is saved. No content was generated and no credits were spent.",
                    );
                  })
                }
                onMessage={(text) =>
                  run(async () => {
                    syncPublication(
                      await request<PublicationView>(
                        "/api/kely/publications/" +
                          publication.id +
                          "/messages",
                        { text, version: publication.version },
                      ),
                    );
                  })
                }
                onApprove={(stage) =>
                  void run(async () => {
                    syncPublication(
                      await request<PublicationView>(
                        "/api/kely/publications/" + publication.id + "/approve",
                        { stage, version: publication.version },
                      ),
                    );
                    setNotice(
                      stage === "content"
                        ? "Content approved. The next visual stage needs its own confirmed quote."
                        : "Cover approved. Your saved cover will be reused.",
                    );
                  })
                }
              />
            )}
          </main>
        </div>
      </div>
      {quote && (
        <QuoteDialog
          completeResult={Boolean(publication?.creation)}
          quote={quote}
          account={account}
          busy={busy}
          error={error?.message}
          errorCode={error?.code}
          onClose={() => setQuote(null)}
          onAccept={() => void acceptQuote()}
          onBilling={() => navigate("billing")}
        />
      )}
    </>
  );
}
