export const LIVE_PROVIDER_DISPATCH_APPROVED = true;

export function assertLiveDispatchApproved() {
  if (!LIVE_PROVIDER_DISPATCH_APPROVED || process.env.KELY_LIVE_ENABLED !== "true" || process.env.KELY_PROVIDER_MODE !== "openai") {
    throw new Error("Live provider dispatch has not been approved by the coordinator.");
  }
}
