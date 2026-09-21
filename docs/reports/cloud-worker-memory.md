# Cloud worker memory reduction

Outcome: ready for deployment after the 1024 px derivative mitigation alone still reproduced the Render 512 MB OOM. The hosted launcher now runs the existing pg-boss consumers in its own process and spawns only Next.js, removing the dedicated worker V8/tsx runtime. Queue names, concurrency, retries and provider dispatch contracts are unchanged.

Changed paths: `src/server/worker.ts`, `scripts/worker-start.ts`, `scripts/cloud-start.ts`, `package.json`.

Checks: 155 unit tests, typecheck and the webpack production build passed. Independent review confirmed unchanged dispatch semantics and requested shutdown/partial-start protections; those were added and typecheck/build repeated successfully. API spend for implementation: USD 0.

Limitations: the immutable cloud budget history remains large and still needs a separately versioned snapshot or compact attempt contract. The change must be accepted only after a real cloud research run remains healthy; the previous real run ended in an OOM and must not be retried automatically.
