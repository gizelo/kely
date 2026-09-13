export type Platform = "linkedin" | "instagram";
export type Tier = "none" | "starter" | "studio";
export type Cadence = "monthly" | "annual";
export type GenerationOrigin = "fixture" | "ai_preview" | "openai";
export type RevisionScope = { target: number; kind: "copy" | "style" | "plan" | "compose" };
export type CostEvidence = { basis: "usage_rated" | "usage_bounded" | "maximum_reserved"; settledMicros: number; uncertainMicros: number; simulated: boolean; model: string };
export type PublicationStatus = "collecting" | "content_approval" | "cover_approval" | "cover_approved" | "running" | "ready" | "failed";
export type OperationKind = "prepare" | "cover" | "remaining" | "revise" | "create";
export type OperationStatus = "queued" | "running" | "completed" | "failed" | "uncertain" | "waiting_input";

export interface BusinessView {
  id: string;
  name: string;
  context: string;
  website: string;
}

export interface AccountView {
  fixture: boolean;
  generationMode?: GenerationOrigin;
  user: { id: string; name: string; email: string };
  business: BusinessView | null;
  billing: {
    tier: Tier;
    cadence: Cadence;
    weeklyRemaining: number;
    packRemaining: number;
    reserved: number;
    nextResetAt: string | null;
    activeUntil: string | null;
    cancelAtPeriodEnd: boolean;
    pendingTier: Exclude<Tier, "none"> | null;
    pendingCadence: Cadence | null;
  };
}

export interface SlideView {
  artworkId?: string;
  creativePlan?: import("./creative-intent").CreativePlan;
  artDirection?: import("./art-direction").FrozenArtDirection;
  id: string;
  index: number;
  title: string;
  body: string;
  assetId?: string;
  copyOrigin?: GenerationOrigin;
  visualOrigin?: "fixture" | "deterministic";
  palette?: "indigo" | "forest" | "rose" | "sand";
}

export interface MessageView {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  origin?: GenerationOrigin;
}

export interface PublicationView {
  creation?: import("./creation").CreationView;
  artwork?: { assetId: string; hash: string; origin: "ai_preview" | "openai" };
  designPolicy?: "art-direction-v1" | "creative-intent-v1" | "creative-intent-v2" | "creative-intent-v3" | "creative-intent-v4" | "creative-intent-v5" | "creative-intent-v6" | "creative-intent-v7" | "creative-intent-v8" | "creative-intent-v9";
  directionProposal?: import("./semantic-direction").PublicationDirectionProposal;
  proposedBrief?: import("./creative-intent").ProposedBrief;
  sourceAnalysis?: import("./creative-intent").SelectedAnalysisContext;
  artDirection?: import("./art-direction").FrozenArtDirection;
  brandBrief?: import("./brand").PublicationBrief;
  brandPalette?: import("./brand").BrandPalette;
  readiness?: import("./brand").ReadinessView;
  preferenceProposals?: import("./preferences").PreferenceProposal[];
  localPreferences?: import("./preferences").LocalPreferences;
  fixture: boolean;
  origin?: GenerationOrigin;
  id: string;
  title: string;
  idea: string;
  platform: Platform;
  language: string;
  slideCount: number;
  status: PublicationStatus;
  version: number;
  outlineApproved: boolean;
  coverApproved: boolean;
  caption: string;
  captionOrigin?: GenerationOrigin;
  slides: SlideView[];
  messages: MessageView[];
  history: { version: number; createdAt: string; label: string; canExportImages?: boolean; canExportCaption?: boolean; origin?: GenerationOrigin; cost?: CostEvidence }[];
  pendingOperation?: { id: string; kind: OperationKind; status: OperationStatus; origin?: GenerationOrigin };
  preparation?: { id: string; activated: boolean; repliesUsed: number; repliesRemaining: number; closed: boolean; origin: GenerationOrigin; retryRemaining: number; attemptsUsed: number; paused: boolean };
  pendingVisualTargets?: number[];
  uncertainFacts?: string[];
  failureCode?: string;
  cost?: CostEvidence;
  failure?: string;
  failedOperationKind?: OperationKind;
  createdAt: string;
  updatedAt: string;
}

export interface QuoteView {
  brand?: { version: number; palette: import("./brand").BrandPalette; artDirection?: import("./art-direction").ArtDirection; notice: string };
  id: string;
  publicationId: string;
  kind: OperationKind;
  version: number;
  credits: number;
  summary: string;
  expiresAt: string;
  fixture: boolean;
  origin?: GenerationOrigin;
  model?: string;
  scope?: RevisionScope;
  preparation?: { included: boolean; maximumReplies: number; repliesRemaining: number; activatesOnFirstUsableReply: boolean };
}

export interface OperationView {
  id: string;
  publicationId: string;
  kind: OperationKind;
  status: OperationStatus;
  error?: string;
  fixture: boolean;
  origin?: GenerationOrigin;
  cost?: CostEvidence;
}

export interface ApiError { error: { code: string; message: string } }
