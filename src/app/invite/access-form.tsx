"use client";

import { useEffect, useState, type FormEvent } from "react";
import { KelyLogo } from "../../components/identity";

export function AccessForm({ recovery = false }: { recovery?: boolean }) {
  const [token, setToken] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    setToken(new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "");
    window.history.replaceState(null, "", window.location.pathname);
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setBusy(true); setMessage("");
    try {
      const response = await fetch(`/api/beta/${recovery ? "recover" : "invite"}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(recovery ? { token, password: values.get("password") } : { token, password: values.get("password"), name: values.get("name"), email: values.get("email"), acceptedTerms: values.get("terms") === "on" }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Please try again.");
      setDone(true); setToken("");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Please try again."); }
    finally { setBusy(false); }
  }
  return <main id="main-content" className="auth-screen beta-access-screen"><section className="auth-card">
    <a className="brand" href="/" aria-label="Kely home"><KelyLogo /></a>
    <h1>{recovery ? "Welcome back." : "You're invited."}</h1>
    {done ? <><p>{recovery ? "Your password is updated. Sign in again to continue." : "Your account is ready. Sign in to meet Kely."}</p><a className="button primary" href="/">Continue to Kely</a></> : <form onSubmit={submit}>
      {!recovery && <><label htmlFor="beta-name">Name</label><input id="beta-name" name="name" required maxLength={100} autoComplete="name" /><label htmlFor="beta-email">Invited email</label><input id="beta-email" name="email" type="email" required maxLength={254} autoComplete="email" /></>}
      <label htmlFor="beta-password">{recovery ? "New password" : "Password"}</label><input id="beta-password" name="password" type="password" required minLength={10} maxLength={128} autoComplete="new-password" />
      <p className="field-hint">Use at least 10 characters.</p>
      {!recovery && <label className="beta-terms-check"><input name="terms" type="checkbox" required /><span>I agree to the <a href="/beta-info" target="_blank" rel="noreferrer">beta terms and privacy information</a>.</span></label>}
      <p className="beta-access-status" role="status">{message || (!token ? recovery ? "Ask the beta organiser for a private recovery link." : "Open the private link from the person who invited you." : "")}</p>
      <button className="button primary full-width" type="submit" disabled={busy || !token}>{busy ? "One moment…" : recovery ? "Update password" : "Create my account"}</button>
    </form>}
  </section></main>;
}
