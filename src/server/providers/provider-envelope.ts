import { assessTextUsage, RATE_SCHEDULE_ID, requestMaximumMicros, validateTextRequest, type BoundedTextRequest } from "./text-envelope";
import { assessVisionUsage, validateVisionRequest, visionMaximumMicros, VISION_RATE_SCHEDULE_ID, type BoundedVisionRequest } from "./vision-envelope";

import { assessImageUsage, imageRateSchedule, imageMaximumMicros, validateImageRequest, type BoundedImageRequest } from "./image-envelope";
import { assessWebSearchUsage, validateWebSearchRequest, webSearchMaximumMicros, WEB_SEARCH_RATE_SCHEDULE_ID, type BoundedWebSearchRequest } from "./web-search-envelope";

export type BoundedProviderRequest = BoundedTextRequest | BoundedVisionRequest | BoundedImageRequest | BoundedWebSearchRequest;
export function validateProviderRequest(value: unknown): BoundedProviderRequest {
  if ((value as { model?: unknown })?.model === "gpt-image-1.5" || Object.hasOwn(value ?? {}, "prompt")) return validateImageRequest(value);
  if ((value as { accountingPolicy?: unknown })?.accountingPolicy === WEB_SEARCH_RATE_SCHEDULE_ID) return validateWebSearchRequest(value);
  return typeof (value as { input?: unknown })?.input === "string" ? validateTextRequest(value) : validateVisionRequest(value);
}
export function providerRateSchedule(value: BoundedProviderRequest) { const valid = validateProviderRequest(value); return "prompt" in valid ? imageRateSchedule(valid) : "accountingPolicy" in valid ? WEB_SEARCH_RATE_SCHEDULE_ID : typeof valid.input === "string" ? RATE_SCHEDULE_ID : VISION_RATE_SCHEDULE_ID; }
export function providerMaximumMicros(value: BoundedProviderRequest) { return "prompt" in value ? imageMaximumMicros(value) : "accountingPolicy" in value ? webSearchMaximumMicros(value) : typeof value.input === "string" ? requestMaximumMicros(value as BoundedTextRequest) : visionMaximumMicros(value as BoundedVisionRequest); }
export function assessProviderUsage(value: BoundedProviderRequest, response: unknown) { return "prompt" in value ? assessImageUsage(value, response) : "accountingPolicy" in value ? assessWebSearchUsage(value, response) : typeof value.input === "string" ? assessTextUsage(value as BoundedTextRequest, response) : assessVisionUsage(value as BoundedVisionRequest, response); }
