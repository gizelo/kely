# Closed beta launch gates

Status: 13 September 2026, not deployed. Invites and real cloud dispatch remain disabled.

## Prepared resources

- Separate Neon Free project `twilight-band-72198345`, `kely-beta`, Frankfurt, PostgreSQL 17. No user data or canonical budget imported.
- Render account is signed in. No service created; Git source connection is not configured. Obtain founder approval for the exact private repository destination and Render repository access before uploading source or expanding permissions.
- `Dockerfile` builds on Linux; `render.yaml` specifies Free Frankfurt, fixture provider, closed invitations and disabled live dispatch. The Linux image started both web and worker against an isolated local database. This is not a cloud deployment test.

## Ordered release procedure

1. Complete browser plan/comment/Generate/results/export QA and review outstanding report findings. Use isolated fixtures until the actual transfer gate.
2. Approve a private source repository. Exclude `.env*`, `.local`, founder datasets, backup archives, budget exports and generated private evidence. Review staged files before any source upload. Never expose source publicly by default.
3. Confirm the account actually offers Free deployment, Frankfurt and no automatic paid upgrade. Configure exact final HTTPS origin, cloud database and a strong auth secret in Render; founder installs secrets without posting them in chat. Do not use fixture credentials from tests.
4. Apply and verify the hash-tracked schema in the fresh cloud database before starting the hosted launcher. Keep `KELY_PROVIDER_MODE=fixture`, `KELY_LIVE_ENABLED=false`, `KELY_BETA_ACCESS_ENABLED=false`.
5. Verify closed registration, HTTPS cookies, origin checks, owner-scoped access and persistence on the hosted service. Confirm backup and restore on a separate database; include actual private artifacts, not just empty schema tables.
6. Stop all local live processes. Read canonical budget status and head; no active dispatch is allowed. Back up the source ledger privately. Coordinator runs `scripts/transfer-budget.ts` preview, exact-head fence-export, inactive import, full state comparison, then activation. Preserve the full original USD10 history and retained liabilities. No other process gets a second allowance.
7. Founder installs the existing approved provider key in Render. Enable real work only after the transfer matches and local spending is fenced. Test Girex, repeat preferences and a no-material business within the remaining shared allowance. Verify real downloads and saved artifacts after restart; no automatic retry of an unknown provider outcome.
8. Obtain founder identity/contact and approval of the beta data notice. Do not promise automated deletion or a retention schedule that has not been implemented. Confirm manual deletion/export workflow before inviting testers.
9. Founder accepts visual quality and complete flow. Then enable invites and issue at most three account invitations total, privately. Founder distributes them. No public signup, purchases or billing.

## Stop and rollback

- Disable new real calls with `KELY_LIVE_ENABLED=false` and `KELY_PROVIDER_MODE=fixture`; disable new invitations separately. Keep saved results readable. This is not permission to retry an interrupted provider request.
- Roll back application code only to a schema-compatible image. Never revert or reset the live budget ledger with an old application/database snapshot.
- A restored database starts disconnected from live generation. Preserve the newest authority and retained liabilities or reconcile independently before any reactivation. An old snapshot cannot establish the latest provider spending.
- Keep original assets, budget evidence and backups private. Quota exhaustion stops new work, not deletion of prior results.

## Acceptance still open

Cloud deployment, actual transfer, real provider quality under the new plan contract, cloud restart/download evidence, independent export review and founder notice/output acceptance. Fixture tests and a local restore rehearsal do not substitute for these gates.
