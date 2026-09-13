import { z } from "zod";
import { canonicalJson, inputHash } from "../paid-input";
import type { BudgetAttempt } from "./store";
import { IMAGE_MODEL_V2 } from "../providers/image-envelope";

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const identifier = z.string().min(1).max(160);
const requestId = z.string().regex(/^req_[a-zA-Z0-9_-]{1,240}$/u);
const bindingSchema = z.object({ key: identifier, ownerId: identifier, operationId: identifier, acceptedHash: hash, stepHash: hash, requestId }).strict();
export const abandonmentReviewSchema = bindingSchema.extend({ reviewId: hash, evidenceHash: hash, attemptInputHash: hash, requestHash: hash, maximumMicros: z.number().int().positive(), classification: z.literal("unsupported_image_model_400").optional() }).strict();
const lostEvidenceSchema = z.object({ _request_id: requestId, evidenceOmitted: z.literal("invalid_or_oversized") }).strict();
const unsupportedModelSchema = z.object({ _request_id: requestId, http_status: z.literal(400), error: z.object({ code: z.literal("invalid_value"), param: z.literal("model"), type: z.literal("image_generation_user_error"), message: z.literal("The model 'gpt-image-1.5-2025-12-16' does not exist.") }).strict() }).strict();
export type AbandonmentBinding = z.infer<typeof bindingSchema>;
export type AbandonmentReview = z.infer<typeof abandonmentReviewSchema>;

export class AbandonmentError extends Error {
  constructor(public readonly code: "abandonment_not_reviewable" | "abandonment_conflict") {
    super("This attempt does not match a reviewed image-failure closure. Preserve its evidence and full liability; no request was retried.");
  }
}

function requireReviewable(condition: unknown): asserts condition {
  if (!condition) throw new AbandonmentError("abandonment_not_reviewable");
}

export function parseAbandonmentBinding(value: unknown): AbandonmentBinding {
  const result = bindingSchema.safeParse(value);
  requireReviewable(result.success);
  return result.data;
}

export function previewStoredAbandonment(attempt: BudgetAttempt | undefined, binding: AbandonmentBinding): AbandonmentReview {
  const exact = parseAbandonmentBinding(binding);
  requireReviewable(attempt && (attempt.status === "uncertain" || attempt.status === "abandoned"));
  requireReviewable(attempt.key === exact.key && attempt.ownerId === exact.ownerId && attempt.operationId === exact.operationId);
  requireReviewable(attempt.key === `kely:${attempt.operationId}:artwork:0` && attempt.step === "artwork:0" && "prompt" in attempt.request);
  requireReviewable(attempt.settledMicros === 0 && attempt.uncertainMicros === attempt.maximumMicros && !attempt.assessment);
  requireReviewable(attempt.snapshot.acceptedHash === exact.acceptedHash && attempt.snapshot.stepHash === exact.stepHash);
  const unsupported = attempt.request.model === IMAGE_MODEL_V2 && attempt.reason === "transport_failed";
  const evidence = (unsupported ? unsupportedModelSchema : lostEvidenceSchema).safeParse(attempt.response);
  requireReviewable(evidence.success && evidence.data._request_id === exact.requestId);
  requireReviewable(unsupported || (attempt.request.model === "gpt-image-1.5" && !("accountingPolicy" in attempt.request) && attempt.reason === "invalid_response"));
  const details = { ...exact, evidenceHash: inputHash(attempt.response), attemptInputHash: attempt.inputHash, requestHash: inputHash(attempt.request), maximumMicros: attempt.maximumMicros, ...(unsupported ? { classification: "unsupported_image_model_400" as const } : {}) };
  const review = { ...details, reviewId: inputHash({ policy: unsupported ? "unsupported-image-model-abandonment-v1" : "received-lost-image-abandonment-v1", ...details }) };
  if (attempt.status === "abandoned") requireReviewable(canonicalJson(attempt.abandonmentReview) === canonicalJson(review));
  return review;
}
