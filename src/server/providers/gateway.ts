import { BudgetError, BudgetStore, type AttemptInput } from "../budget/store";
import type { UsageAssessment } from "./text-envelope";
import type { BoundedProviderRequest } from "./provider-envelope";
import { assertLiveDispatchApproved } from "./live-gate";
import { readProviderResponse, serializeProviderRequest, ReceivedTransportError } from "./http-transport";
import { approvedProviderCredential } from "./credential";
import { ImageUsageValidationError } from "./image-envelope";
import { CloudBudgetStore } from "../budget/cloud-store";
import { pool } from "../db";

export type FakeTextTransport = {
  kind: "fake";
  send(request: BoundedProviderRequest, context: { attemptKey: string; signal: AbortSignal; receivedEvidence?: (evidence: unknown) => void }): Promise<unknown>;
};

class ProviderGateway {
  constructor(private readonly budget: BudgetStore | CloudBudgetStore, private readonly transport: Pick<FakeTextTransport, "send">, private readonly timeoutMs = 30_000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error("Invalid bounded transport timeout.");
  }

  async accountedExposure(key: string) {
    const attempt = (await this.budget.inspect()).attempts.find((value) => value.key === key);
    return attempt ? { basis: attempt.assessment?.basis ?? "maximum_reserved" as const, settledMicros: attempt.settledMicros, uncertainMicros: attempt.uncertainMicros + (attempt.status === "dispatching" ? attempt.maximumMicros : 0) } : undefined;
  }

  async dispatch(input: AttemptInput): Promise<{ response: unknown; assessment: UsageAssessment; replayed: boolean }> {
    const claim = await this.budget.claim(input);
    if (!claim.dispatched) {
      if (claim.attempt.status === "settled") return { response: claim.attempt.response, assessment: claim.attempt.assessment!, replayed: true };
      throw new BudgetError("attempt_uncertain", "This step was already claimed. It will not be sent again; inspect its recorded outcome.");
    }
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let response: unknown;
    let receivedEvidence: unknown;
    try {
      response = await Promise.race([
        Promise.resolve().then(() => this.transport.send(claim.attempt.request, { attemptKey: claim.attempt.key, signal: controller.signal, receivedEvidence: (evidence) => { receivedEvidence = evidence; } })),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new Error("timeout")); }, "prompt" in claim.attempt.request ? 180_000 : this.timeoutMs); }),
      ]);
    } catch (error) {
      await this.budget.markUncertain(claim.attempt.key, timedOut ? "timeout" : "transport_failed", error instanceof ReceivedTransportError ? error.evidence : receivedEvidence);
      throw new BudgetError("attempt_uncertain", "The provider outcome is unknown. Its maximum exposure is retained; no automatic retry is allowed.");
    } finally { if (timer) clearTimeout(timer); }
    try {
      const assessment = await this.budget.settle(claim.attempt.key, response);
      return { response, assessment, replayed: false };
    } catch (error) {
      const issues = error instanceof ImageUsageValidationError ? error.issues : error instanceof BudgetError ? [{ path: "budget", code: error.code }] : [{ path: "response", code: "validation_failed" }];
      await this.budget.markUncertain(claim.attempt.key, "invalid_response", response, issues);
      throw new BudgetError("attempt_uncertain", "Usage or settlement could not be verified. The attempt remains accounted for and will not be retried.");
    }
  }
}

export class FakeProviderGateway extends ProviderGateway {
  constructor(budget: BudgetStore, transport: FakeTextTransport, timeoutMs = 30_000) {
    if (budget.location.purpose !== "fake" || transport.kind !== "fake") throw new Error("Fake transports require an isolated fake authority.");
    super(budget, transport, timeoutMs);
  }
}

export function createLiveGateway() {
  assertLiveDispatchApproved();
  const key = approvedProviderCredential();
  const budget = process.env.KELY_RUNTIME === "cloud"
    ? new CloudBudgetStore(pool, process.env.KELY_BUDGET_DESTINATION ?? "")
    : BudgetStore.openDevelopment();
  return new ProviderGateway(budget, { async send(request, context) {
    assertLiveDispatchApproved();
    const image = "prompt" in request;
    const response = await fetch(image ? "https://api.openai.com/v1/images/generations" : "https://api.openai.com/v1/responses", {
      method: "POST", redirect: "manual", signal: context.signal, cache: "no-store",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "x-client-request-id": context.attemptKey },
      body: serializeProviderRequest(request),
    });
    context.receivedEvidence?.({ _request_id: (response.headers.get("x-request-id") ?? "").slice(0, 256), http_status: response.status });
    return readProviderResponse(response, image);
  } });
}
