import { KelyLogo } from "../../components/identity";

export const dynamic = "force-dynamic";

export default function BetaInfoPage() {
  const name = process.env.KELY_OPERATOR_NAME;
  const email = process.env.KELY_SUPPORT_EMAIL;
  return <main id="main-content" className="auth-screen beta-info-screen"><article className="auth-card">
    <a className="brand" href="/" aria-label="Kely home"><KelyLogo /></a><h1>Private beta</h1>
    {!name || !email ? <p>Invitations are closed while the operator and privacy information are being confirmed.</p> : <>
      <p>Operated by {name}. Contact: <a href={`mailto:${email}`}>{email}</a>.</p>
      <h2>Testing, without payments</h2><p>Kely is an invitation-only experimental service. There are no subscription charges. Access and generation are limited, availability is not guaranteed, and the server may take a minute to wake up. You are responsible for reviewing factual claims and the final design before using an output.</p>
      <h2>Your information</h2><p>We store your account details, password hash, ideas, conversations, brand preferences, uploaded materials and generated posts to provide the service. Passwords are not sent to the AI provider. Render hosts the application and Neon stores the data. Relevant prompts and materials are sent to OpenAI to perform requested AI work.</p>
      <p>Only upload material you have permission to use. Do not upload confidential, medical or other sensitive personal information during this beta. Links and reference images may contain information about other people; obtain permission where needed.</p>
      <h2>Access and deletion</h2><p>Your workspace is private to your account and the operator administering the beta. Contact the operator for access recovery, a copy of your data or deletion. Deletion requests are handled by the operator, not an automatic self-service feature. Limited cost and security records may need to remain to prevent repeated spending or abuse; the operator will explain any retained information when handling your request.</p>
      <p>We use necessary session cookies for sign-in. No advertising or optional tracking is included. This notice describes the beta and does not establish that generated content is accurate, unique or cleared for commercial use.</p>
    </>}
  </article></main>;
}
