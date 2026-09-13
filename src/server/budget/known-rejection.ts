import { z } from "zod";
import { canonicalJson, inputHash } from "../paid-input";
import type { BudgetAttempt } from "./store";

const REVIEW_POLICY = "kely-known-rejection-luna-quota-2026-09-11-v1";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().min(1).max(160);
const requestId = z.string().min(1).max(255).regex(/^[a-zA-Z0-9_-]+$/);
const bindingSchema = z.object({ key: identifier, ownerId: identifier, operationId: identifier, acceptedHash: hash, requestId }).strict();
export const knownRejectionReviewSchema = bindingSchema.extend({ reviewId: hash, evidenceHash: hash, attemptInputHash: hash, requestHash: hash, maximumMicros: z.number().int().positive() }).strict();
const evidenceSchema = z.object({
  _request_id: requestId,
  http_status: z.literal(429),
  error: z.object({
    type: z.literal("insufficient_quota"), code: z.literal("credit_balance_exhausted"), param: z.null(),
    message: z.string().min(1).max(4096).refine((value) => value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= 4096),
  }).strict(),
}).strict();

export type KnownRejectionBinding = z.infer<typeof bindingSchema>;
export type KnownRejectionReview = z.infer<typeof knownRejectionReviewSchema>;

export class KnownRejectionError extends Error {
  constructor(public readonly code: "rejection_not_reviewable" | "rejection_review_conflict", message: string) { super(message); }
}

function requireReviewable(condition: unknown): asserts condition {
  if (!condition) throw new KnownRejectionError("rejection_not_reviewable", "This saved attempt does not match the complete, bound Luna quota-rejection policy. Its evidence and maximum exposure remain unchanged.");
}

export function parseKnownRejectionBinding(value: unknown): KnownRejectionBinding {
  const result = bindingSchema.safeParse(value);
  requireReviewable(result.success);
  return result.data;
}

export function previewStoredKnownRejection(attempt: BudgetAttempt | undefined, binding: KnownRejectionBinding): KnownRejectionReview {
  const exact = parseKnownRejectionBinding(binding);
  requireReviewable(attempt && (attempt.status === "uncertain" || attempt.status === "rejected"));
  requireReviewable(attempt.key === exact.key && attempt.ownerId === exact.ownerId && attempt.operationId === exact.operationId);
  requireReviewable(attempt.step === "text" && attempt.request.model === "gpt-5.6-luna" && attempt.reason === "transport_failed");
  requireReviewable(attempt.settledMicros === 0 && attempt.uncertainMicros === attempt.maximumMicros && attempt.assessment === undefined);
  requireReviewable(attempt.snapshot.acceptedHash === exact.acceptedHash && attempt.snapshot.input !== undefined);
  requireReviewable(inputHash(attempt.snapshot.input) === exact.acceptedHash);
  const evidence = evidenceSchema.safeParse(attempt.response);
  requireReviewable(evidence.success && evidence.data._request_id === exact.requestId);
  const details = { ...exact, evidenceHash: inputHash(attempt.response), attemptInputHash: attempt.inputHash, requestHash: inputHash(attempt.request), maximumMicros: attempt.maximumMicros };
  const review = { ...details, reviewId: inputHash({ policy: REVIEW_POLICY, ...details }) };
  if (attempt.status === "rejected") requireReviewable(attempt.rejectionReview && canonicalJson(attempt.rejectionReview) === canonicalJson(review));
  return review;
}
