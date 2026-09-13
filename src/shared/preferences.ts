export interface PreferenceProposal {
  id: string;
  field: "audience" | "voice" | "headlines";
  value: string;
  scope: "durable" | "local" | "ambiguous";
  messageId: string;
  evidence: string;
  reason: string;
}
export interface LocalPreferences { audience?: string; voice?: string; headlines?: "default" | "shorter" }
