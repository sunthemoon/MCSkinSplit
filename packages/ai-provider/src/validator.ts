import {
  componentMaskFile,
  getSkinLayout,
  maskToPixelIds,
  paletteForMask,
  pixelIdsToMask,
  pixelIdsToSpans,
  validateSemanticState,
  type RgbaImage,
  type SemanticComponent,
  type SemanticState,
  type SkinLayout,
} from "@mc-skin-split/skin-core";
import type { AnalysisPack } from "@mc-skin-split/skin-analysis-pack";
import Ajv2020, { type ErrorObject } from "ajv/dist/2020.js";
import {
  ANALYSIS_PROPOSAL_SCHEMA,
  PROPOSAL_VALIDATOR_VERSION,
} from "./schema";
import type {
  AnalysisProposal,
  AnalysisProposalComponent,
  ProposalValidationIssue,
  ProposalValidationReport,
  ProposalValidationResult,
} from "./types";

const ajv = new Ajv2020({
  allErrors: true,
  allowUnionTypes: true,
  strict: true,
});
const validateSchema = ajv.compile(ANALYSIS_PROPOSAL_SCHEMA);

export function validateAnalysisProposal(input: {
  readonly proposal: unknown;
  readonly pack: AnalysisPack;
  readonly image: RgbaImage;
  readonly aiRunId: string;
  readonly confidenceThreshold?: number;
}): ProposalValidationResult {
  const errors: ProposalValidationIssue[] = [];
  const warnings: ProposalValidationIssue[] = [];
  const candidatePixelIds = new Set(
    input.pack.candidateRegions.regions.flatMap((region) => region.pixelIds),
  );
  const emptyStats = {
    candidateRegionCount: input.pack.candidateRegions.regions.length,
    visiblePixelCount: candidatePixelIds.size,
    componentCount: 0,
    assignedPixelCount: 0,
    unknownPixelCount: candidatePixelIds.size,
    needsReviewComponentCount: 0,
    reviewItemCount: 0,
  };

  if (!validateSchema(input.proposal)) {
    errors.push(...schemaIssues(validateSchema.errors ?? []));
    return invalidResult(null, errors, warnings, emptyStats);
  }

  const proposal = input.proposal as unknown as AnalysisProposal;
  if (proposal.sourceRevisionId !== input.pack.job.sourceRevisionId) {
    errors.push(issue("SOURCE_REVISION_MISMATCH", "/sourceRevisionId", "提案来源 Revision 与任务不一致"));
  }
  if (proposal.modelAssessment.armType !== input.pack.job.armType) {
    errors.push(issue("ARM_TYPE_MISMATCH", "/modelAssessment/armType", "AI 不得改变任务的 Wide/Slim 模型"));
  }

  const regionById = new Map(
    input.pack.candidateRegions.regions.map((region) => [region.id, region]),
  );
  const bucketByRegion = new Map<string, string>();
  const componentIds = new Set<string>();
  for (const [index, component] of proposal.components.entries()) {
    const path = `/components/${index}`;
    if (componentIds.has(component.instanceId)) {
      errors.push(issue("DUPLICATE_COMPONENT_ID", `${path}/instanceId`, `组件 ID 重复：${component.instanceId}`));
    }
    componentIds.add(component.instanceId);
    if (component.category === "unknown") {
      errors.push(issue("UNKNOWN_COMPONENT_CATEGORY", `${path}/category`, "不确定区域应留在 unknown mask，而不是创建 unknown 组件"));
    }
    for (const regionId of component.candidateRegionIds) {
      claimRegion(regionId, `component:${component.instanceId}`, path, regionById, bucketByRegion, errors);
    }
  }
  for (const regionId of proposal.unassignedCandidateRegionIds) {
    claimRegion(regionId, "unassigned", "/unassignedCandidateRegionIds", regionById, bucketByRegion, errors);
  }
  for (const [index, reviewItem] of proposal.reviewItems.entries()) {
    for (const regionId of reviewItem.candidateRegionIds) {
      claimRegion(regionId, `review:${index}`, `/reviewItems/${index}`, regionById, bucketByRegion, errors);
    }
  }
  for (const regionId of regionById.keys()) {
    if (!bucketByRegion.has(regionId)) {
      errors.push(issue("UNCOVERED_REGION", "/", `候选区域未被分类、留空或列入审核：${regionId}`));
    }
  }

  validateRelations(proposal, componentIds, errors);
  const layout = getSkinLayout(input.pack.job.armType);
  const occupiedBy = new Map<number, string>();
  const normalizedComponents: SemanticComponent[] = [];
  const masks: Record<string, Uint8Array> = {};
  const threshold = input.confidenceThreshold ?? 0.65;

  for (const [index, component] of proposal.components.entries()) {
    const path = `/components/${index}`;
    const pixels = new Set<number>();
    for (const regionId of component.candidateRegionIds) {
      const region = regionById.get(regionId);
      if (region) for (const pixelId of region.pixelIds) pixels.add(pixelId);
    }
    for (const pixelId of proposalSpansToPixelIds(component.pixelOverrides.remove, `${path}/pixelOverrides/remove`, candidatePixelIds, errors)) {
      if (!pixels.delete(pixelId)) {
        errors.push(issue("INVALID_REMOVE_OVERRIDE", `${path}/pixelOverrides/remove`, `移除像素不属于组件候选区域：${pixelId}`));
      }
    }
    for (const pixelId of proposalSpansToPixelIds(component.pixelOverrides.add, `${path}/pixelOverrides/add`, candidatePixelIds, errors)) {
      pixels.add(pixelId);
    }
    if (pixels.size === 0) {
      errors.push(issue("EMPTY_COMPONENT", path, `组件没有有效像素：${component.instanceId}`));
      continue;
    }
    for (const pixelId of pixels) {
      const previous = occupiedBy.get(pixelId);
      if (previous && previous !== component.instanceId) {
        errors.push(issue("PIXEL_OVERLAP", path, `组件 ${previous} 与 ${component.instanceId} 重叠像素 ${pixelId}`));
      } else {
        occupiedBy.set(pixelId, component.instanceId);
      }
    }
    const mask = pixelIdsToMask(pixels);
    masks[component.instanceId] = mask;
    const needsReview = component.confidence < threshold;
    if (needsReview) {
      warnings.push(issue("LOW_CONFIDENCE_COMPONENT", `${path}/confidence`, `组件 ${component.instanceId} 需要人工审核`, { confidence: component.confidence, threshold }));
    }
    normalizedComponents.push(
      normalizeComponent(
        component,
        mask,
        input.image,
        layout,
        input.aiRunId,
        needsReview,
      ),
    );
  }

  const unknownMask = pixelIdsToMask(
    [...candidatePixelIds].filter((pixelId) => !occupiedBy.has(pixelId)),
  );
  const stats = {
    candidateRegionCount: regionById.size,
    visiblePixelCount: candidatePixelIds.size,
    componentCount: normalizedComponents.length,
    assignedPixelCount: occupiedBy.size,
    unknownPixelCount: maskToPixelIds(unknownMask).length,
    needsReviewComponentCount: normalizedComponents.filter((component) => component.reviewState === "needs_review").length,
    reviewItemCount: proposal.reviewItems.length,
  };
  if (errors.length > 0) return invalidResult(proposal, errors, warnings, stats);

  const completeState: SemanticState = {
    document: {
      schemaVersion: "1.0",
      revisionId: input.pack.job.sourceRevisionId,
      source: {
        width: 64,
        height: 64,
        armType: input.pack.job.armType,
        coordinateOrigin: "top-left",
        sourceHash: input.pack.job.sourceSkinHash,
      },
      components: normalizedComponents.sort((left, right) => left.instanceId.localeCompare(right.instanceId)),
      unknown: {
        maskFile: "components/unknown.mask.png",
        pixelCount: stats.unknownPixelCount,
      },
    },
    masks,
    unknownMask,
  };
  try {
    validateSemanticState(completeState, input.image, layout);
  } catch (error) {
    errors.push(issue("SEMANTIC_STATE_INVALID", "/", error instanceof Error ? error.message : "语义状态校验失败"));
    return invalidResult(proposal, errors, warnings, stats);
  }
  const report = reportOf(true, errors, warnings, stats) as ProposalValidationReport & { valid: true };
  return { proposal, state: completeState, report };
}

function normalizeComponent(
  component: AnalysisProposalComponent,
  mask: Uint8Array,
  image: RgbaImage,
  layout: SkinLayout,
  aiRunId: string,
  needsReview: boolean,
): SemanticComponent {
  return {
    instanceId: component.instanceId,
    displayName: component.displayName,
    category: component.category,
    ...(component.subtype ? { subtype: component.subtype } : {}),
    confidence: component.confidence,
    reviewState: needsReview ? "needs_review" : "confirmed",
    maskFile: componentMaskFile(component.instanceId),
    spans: pixelIdsToSpans(maskToPixelIds(mask), layout),
    palette: paletteForMask(image, mask),
    relations: {
      attachedTo: component.relations.attachedTo,
      pairedWith: [...component.relations.pairedWith].sort(),
      sameOutfitGroup: component.relations.sameOutfitGroup,
    },
    provenance: {
      actorType: "ai",
      aiRunId,
      containsGeneratedPixels: false,
    },
  };
}

function validateRelations(
  proposal: AnalysisProposal,
  componentIds: ReadonlySet<string>,
  errors: ProposalValidationIssue[],
): void {
  for (const [index, component] of proposal.components.entries()) {
    const relations = [
      ...(component.relations.attachedTo ? [component.relations.attachedTo] : []),
      ...component.relations.pairedWith,
    ];
    for (const target of relations) {
      if (!componentIds.has(target)) {
        errors.push(issue("UNKNOWN_RELATION_TARGET", `/components/${index}/relations`, `关系引用不存在的组件：${target}`));
      }
      if (target === component.instanceId) {
        errors.push(issue("SELF_RELATION", `/components/${index}/relations`, `组件不能引用自身：${target}`));
      }
    }
  }
}

function claimRegion(
  regionId: string,
  bucket: string,
  path: string,
  known: ReadonlyMap<string, unknown>,
  claims: Map<string, string>,
  errors: ProposalValidationIssue[],
): void {
  if (!known.has(regionId)) {
    errors.push(issue("UNKNOWN_REGION", path, `候选区域不存在：${regionId}`));
    return;
  }
  const previous = claims.get(regionId);
  if (previous) {
    errors.push(issue("REGION_MULTIPLE_OWNERS", path, `候选区域被重复使用：${regionId}`, { previous, bucket }));
  } else {
    claims.set(regionId, bucket);
  }
}

function proposalSpansToPixelIds(
  spans: readonly { readonly y: number; readonly x0: number; readonly x1: number }[],
  path: string,
  visiblePixels: ReadonlySet<number>,
  errors: ProposalValidationIssue[],
): number[] {
  const result = new Set<number>();
  for (const [index, span] of spans.entries()) {
    if (span.x0 > span.x1) {
      errors.push(issue("INVALID_SPAN", `${path}/${index}`, "span 必须满足 x0 <= x1"));
      continue;
    }
    for (let x = span.x0; x <= span.x1; x += 1) {
      const pixelId = span.y * 64 + x;
      if (!visiblePixels.has(pixelId)) {
        errors.push(issue("INVALID_OVERRIDE_PIXEL", `${path}/${index}`, `override 指向透明或未使用 UV 像素：${x},${span.y}`));
      } else if (result.has(pixelId)) {
        errors.push(issue("DUPLICATE_OVERRIDE_PIXEL", `${path}/${index}`, `override 重复像素：${x},${span.y}`));
      } else {
        result.add(pixelId);
      }
    }
  }
  return [...result].sort((left, right) => left - right);
}

function schemaIssues(errors: readonly ErrorObject[]): ProposalValidationIssue[] {
  return errors.map((error) =>
    issue("SCHEMA_INVALID", error.instancePath || "/", error.message ?? "JSON Schema 校验失败", {
      keyword: error.keyword,
      params: error.params,
    }),
  );
}

function invalidResult(
  proposal: AnalysisProposal | null,
  errors: readonly ProposalValidationIssue[],
  warnings: readonly ProposalValidationIssue[],
  stats: ProposalValidationReport["stats"],
): ProposalValidationResult {
  return {
    proposal,
    state: null,
    report: reportOf(false, errors, warnings, stats) as ProposalValidationReport & { valid: false },
  };
}

function reportOf(
  valid: boolean,
  errors: readonly ProposalValidationIssue[],
  warnings: readonly ProposalValidationIssue[],
  stats: ProposalValidationReport["stats"],
): ProposalValidationReport {
  return {
    schemaVersion: "1.0",
    validatorVersion: PROPOSAL_VALIDATOR_VERSION,
    valid,
    errors,
    warnings,
    stats,
  };
}

function issue(
  code: string,
  path: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): ProposalValidationIssue {
  return { code, path, message, ...(details ? { details } : {}) };
}
