import type { Platform, PublicationView } from "./contracts";

export interface CreationView {
  status: "quoted" | "queued" | "working" | "needs_input" | "plan_ready" | "ready" | "failed" | "paused";
  phase: "context" | "analysis" | "design" | "plan" | "artwork" | "composition" | "complete";
  credits: number;
  questions: string[];
  canReply: boolean;
  operationId?: string;
  quote?: CreationQuoteView;
  plan?: { version: number; hash: string; approved: boolean; visualDirection: string; approvalRequestKey?: string; approvedPublicationVersion?: number };
  discussionLimitReached?: boolean;
  artworkLayout?: "landscape-editorial-v1";
  cancelled?: boolean;
}

export interface CreationQuoteView {
  id: string;
  publicationId: string;
  credits: number;
  expiresAt: string;
  summary: string;
  format: { platform: Platform; slideCount: number; basis: "suggested" | "chosen" };
}

export interface CreationResponse { publication: PublicationView; creation: CreationView }
