import proposalSchema from "./analysis-proposal.schema.json" with { type: "json" };
import previousProposalSchema from "./analysis-proposal.v1.1.schema.json" with { type: "json" };
import legacyProposalSchema from "./analysis-proposal.v1.schema.json" with { type: "json" };
import replacementProposalSchema from "./replacement-plan.schema.json" with { type: "json" };
import completionRankingSchema from "./completion-ranking.schema.json" with { type: "json" };

export const ANALYSIS_PROPOSAL_SCHEMA = proposalSchema;
export const ANALYSIS_PROPOSAL_SCHEMA_VERSION = "1.2";
export const PREVIOUS_ANALYSIS_PROPOSAL_SCHEMA_VERSION = "1.1";
export const PREVIOUS_ANALYSIS_PROPOSAL_SCHEMA = previousProposalSchema;
export const LEGACY_ANALYSIS_PROPOSAL_SCHEMA_VERSION = "1.0";
export const LEGACY_ANALYSIS_PROPOSAL_SCHEMA = legacyProposalSchema;
export const AI_SKILL_NAME = "mc-skin-segmenter";
export const AI_SKILL_VERSION = "1.4.0";
export const PROPOSAL_VALIDATOR_VERSION = "semantic-proposal-validator-v3";
export const MAX_PROPOSAL_OVERRIDE_PIXELS = 64;
export const MAX_PROPOSAL_OVERRIDE_SPANS = 32;
export const REPLACEMENT_PLAN_SCHEMA = replacementProposalSchema;
export const REPLACEMENT_PLANNER_SKILL_NAME = "mc-skin-replacement-planner";
export const REPLACEMENT_PLANNER_SKILL_VERSION = "1.0.0";
export const REPLACEMENT_PLAN_VALIDATOR_VERSION =
  "replacement-plan-validator-v1";
export const COMPLETION_RANKING_SCHEMA = completionRankingSchema;
export const COMPLETION_RANKING_SCHEMA_VERSION = "1.0";
export const COMPLETION_RANKING_VALIDATOR_VERSION =
  "completion-ranking-validator-v1";
