import { getSkinLayout } from "../layouts/layout";
import type { ArmType, RgbaImage, SkinLayout } from "../types";
import { isSemanticCategory } from "./taxonomy";
import {
  assertMask,
  maskToPixelIds,
  pixelIdsToMask,
  pixelIdsToSpans,
  spansToPixelIds,
} from "./mask";
import {
  summarizePixelOriginsForMask,
  validatePixelOriginDocument,
} from "./origin";
import type {
  ManualSemanticOperation,
  ComponentRelations,
  SegmentationDocument,
  SemanticComponent,
  SemanticComponentInput,
  SemanticComponentProvenance,
  SemanticState,
  ProvenanceSemanticAssignment,
  PixelOriginDocument,
} from "./types";

const INSTANCE_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
export const UNKNOWN_MASK_FILE = "components/unknown.mask.png";

export class SemanticEditError extends Error {
  readonly code:
    | "INVALID_COMPONENT"
    | "INVALID_SELECTION"
    | "OVERLAPPING_COMPONENTS";

  constructor(
    code: SemanticEditError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SemanticEditError";
    this.code = code;
  }
}

export function applyManualSemanticOperation(
  state: SemanticState,
  operation: ManualSemanticOperation,
  image: RgbaImage,
): SemanticState {
  const layout = getSkinLayout(state.document.source.armType);
  validateSemanticState(state, image, layout);

  switch (operation.type) {
    case "assign_pixels":
      return assignPixels(
        state,
        operation.target,
        spansToPixelIds(operation.spans, layout),
        image,
        layout,
      );
    case "unassign_pixels":
      return unassignPixels(
        state,
        spansToPixelIds(operation.spans, layout),
        image,
        layout,
      );
    case "merge_components":
      return mergeComponents(
        state,
        operation.componentIds,
        operation.target,
        image,
        layout,
      );
    case "split_component":
      return splitComponent(
        state,
        operation.sourceComponentId,
        operation.target,
        spansToPixelIds(operation.spans, layout),
        image,
        layout,
      );
    case "reclassify_component":
      return reclassifyComponent(
        state,
        operation.componentId,
        operation.category,
        operation.subtype,
        image,
        layout,
      );
    case "set_component_relations":
      return setComponentRelations(
        state,
        operation.componentId,
        operation.relations,
        image,
        layout,
      );
  }
}

/**
 * Assigns deterministic result pixels while preserving explicit origin evidence.
 * This is intended for host-validated workflows such as composition restoration;
 * ordinary editor gestures continue through applyManualSemanticOperation.
 */
export function assignSemanticPixelsWithProvenance(
  state: SemanticState,
  assignment: ProvenanceSemanticAssignment,
  image: RgbaImage,
): SemanticState {
  const layout = getSkinLayout(state.document.source.armType);
  validateSemanticState(state, image, layout);
  validateProvenance(assignment.provenance);
  return assignPixels(
    state,
    assignment.target,
    spansToPixelIds(assignment.spans, layout),
    image,
    layout,
    assignment.provenance,
    false,
  );
}

export function createInitialSemanticState(input: {
  readonly revisionId: string;
  readonly armType: ArmType;
  readonly sourceHash: string;
  readonly image: RgbaImage;
}): SemanticState {
  const layout = getSkinLayout(input.armType);
  const unknownMask = pixelIdsToMask(visibleUsedPixelIds(input.image, layout));
  const state: SemanticState = {
    document: {
      schemaVersion: "1.0",
      revisionId: input.revisionId,
      source: {
        width: 64,
        height: 64,
        armType: input.armType,
        coordinateOrigin: "top-left",
        sourceHash: input.sourceHash,
      },
      components: [],
      unknown: {
        maskFile: UNKNOWN_MASK_FILE,
        pixelCount: maskToPixelIds(unknownMask).length,
      },
    },
    masks: {},
    unknownMask,
  };
  validateSemanticState(state, input.image, layout);
  return state;
}

export function rebaseSemanticStateImage(input: {
  readonly state: SemanticState;
  readonly sourceImage: RgbaImage;
  readonly resultImage: RgbaImage;
  readonly sourceHash: string;
}): SemanticState {
  const layout = getSkinLayout(input.state.document.source.armType);
  validateSemanticState(input.state, input.sourceImage, layout);
  if (input.resultImage.width !== 64 || input.resultImage.height !== 64) {
    throw new SemanticEditError("INVALID_SELECTION", "Semantic image must be 64x64");
  }
  const components: SemanticComponent[] = [];
  const masks: Record<string, Uint8Array> = {};
  const removedComponentIds = new Set<string>();
  for (const component of input.state.document.components) {
    const remaining = maskToPixelIds(input.state.masks[component.instanceId]!).filter(
      (pixelId) => input.resultImage.data[pixelId * 4 + 3] !== 0,
    );
    if (remaining.length === 0) {
      removedComponentIds.add(component.instanceId);
      continue;
    }
    const mask = pixelIdsToMask(remaining);
    masks[component.instanceId] = mask;
    components.push(
      refreshComponent(component, mask, input.resultImage, layout),
    );
  }
  return finalizeState(
    {
      ...input.state.document,
      source: { ...input.state.document.source, sourceHash: input.sourceHash },
    },
    rewriteRelationsAfterComponentRemoval(
      components,
      new Map(
        [...removedComponentIds].map((componentId) => [componentId, null]),
      ),
    ),
    masks,
    input.resultImage,
    layout,
  );
}

export function validateSemanticState(
  state: SemanticState,
  image: RgbaImage,
  layout: SkinLayout = getSkinLayout(state.document.source.armType),
): void {
  if (image.width !== 64 || image.height !== 64) {
    throw new SemanticEditError("INVALID_SELECTION", "Semantic image must be 64x64");
  }
  const componentIds = new Set<string>();
  const occupied = new Int16Array(64 * 64);
  occupied.fill(-1);

  for (const [componentIndex, component] of state.document.components.entries()) {
    validateComponentInput(component);
    if (componentIds.has(component.instanceId)) {
      throw new SemanticEditError(
        "INVALID_COMPONENT",
        `Duplicate component id: ${component.instanceId}`,
      );
    }
    componentIds.add(component.instanceId);
    if (component.maskFile !== componentMaskFile(component.instanceId)) {
      throw new SemanticEditError(
        "INVALID_COMPONENT",
        `Component ${component.instanceId} mask path is not canonical`,
      );
    }
    const mask = state.masks[component.instanceId];
    if (!mask) {
      throw new SemanticEditError(
        "INVALID_COMPONENT",
        `Component ${component.instanceId} has no mask`,
      );
    }
    assertMask(mask);
    const pixelIds = maskToPixelIds(mask);
    if (pixelIds.length === 0) {
      throw new SemanticEditError(
        "INVALID_COMPONENT",
        `Component ${component.instanceId} mask is empty`,
      );
    }
    const canonicalSpans = pixelIdsToSpans(pixelIds, layout);
    if (!spansEqual(component.spans, canonicalSpans)) {
      throw new SemanticEditError(
        "INVALID_COMPONENT",
        `Component ${component.instanceId} spans do not match its mask`,
      );
    }
    const palette = paletteForMask(image, mask);
    if (!palettesEqual(component.palette, palette)) {
      throw new SemanticEditError(
        "INVALID_COMPONENT",
        `Component ${component.instanceId} palette is not deterministic`,
      );
    }
    validateProvenance(component.provenance, pixelIds.length);
    for (const pixelId of pixelIds) {
      if (image.data[pixelId * 4 + 3] === 0) {
        throw new SemanticEditError(
          "INVALID_COMPONENT",
          `Component ${component.instanceId} contains transparent pixel ${pixelId}`,
        );
      }
      if (occupied[pixelId] !== -1) {
        throw new SemanticEditError(
          "OVERLAPPING_COMPONENTS",
          `Components overlap at pixel ${pixelId}`,
        );
      }
      occupied[pixelId] = componentIndex;
    }
  }

  const maskIds = Object.keys(state.masks).sort();
  const documentIds = [...componentIds].sort();
  if (JSON.stringify(maskIds) !== JSON.stringify(documentIds)) {
    throw new SemanticEditError(
      "INVALID_COMPONENT",
      "Semantic masks contain missing or unknown component ids",
    );
  }

  assertMask(state.unknownMask);
  if (state.document.unknown.maskFile !== UNKNOWN_MASK_FILE) {
    throw new SemanticEditError(
      "INVALID_COMPONENT",
      "Unknown mask path is not canonical",
    );
  }
  const expectedUnknownMask = unassignedVisibleMask(image, layout, occupied);
  if (!masksEqual(state.unknownMask, expectedUnknownMask)) {
    throw new SemanticEditError(
      "INVALID_COMPONENT",
      "Unknown mask does not cover exactly the unassigned visible UV pixels",
    );
  }
  const unknownPixelCount = maskToPixelIds(state.unknownMask).length;
  if (state.document.unknown.pixelCount !== unknownPixelCount) {
    throw new SemanticEditError(
      "INVALID_COMPONENT",
      "Unknown pixel count does not match its mask",
    );
  }
}

/**
 * Replaces legacy component booleans with summaries derived from authoritative
 * per-pixel origins. This does not change ownership or origin entries.
 */
export function synchronizeSemanticPixelOriginSummaries(
  state: SemanticState,
  originDocument: PixelOriginDocument,
  image: RgbaImage,
): SemanticState {
  validatePixelOriginDocument(originDocument, image);
  if (
    originDocument.subject.kind !== "revision" ||
    originDocument.subject.id !== state.document.revisionId ||
    originDocument.source.armType !== state.document.source.armType
  ) {
    throw new SemanticEditError(
      "INVALID_COMPONENT",
      "Pixel origin document does not match the semantic Revision",
    );
  }
  return {
    document: {
      ...state.document,
      components: state.document.components.map((component) => {
        const originSummary = summarizePixelOriginsForMask(
          originDocument,
          state.masks[component.instanceId]!,
        );
        return {
          ...component,
          provenance: {
            ...component.provenance,
            containsGeneratedPixels: originSummary.containsGeneratedPixels,
            originSummary,
          },
        };
      }),
    },
    masks: state.masks,
    unknownMask: state.unknownMask,
  };
}

export function componentMaskFile(instanceId: string): string {
  validateInstanceId(instanceId);
  return `components/${instanceId}.mask.png`;
}

export function paletteForMask(
  image: RgbaImage,
  mask: Uint8Array,
): { readonly dominant: string; readonly colors: readonly string[] } {
  assertMask(mask);
  const counts = new Map<string, number>();
  for (const pixelId of maskToPixelIds(mask)) {
    const offset = pixelId * 4;
    if (image.data[offset + 3] === 0) {
      continue;
    }
    const color = `#${hex(image.data[offset]!)}${hex(image.data[offset + 1]!)}${hex(image.data[offset + 2]!)}`;
    counts.set(color, (counts.get(color) ?? 0) + 1);
  }
  const colors = [...counts]
    .sort(([leftColor, leftCount], [rightColor, rightCount]) =>
      rightCount === leftCount
        ? leftColor.localeCompare(rightColor)
        : rightCount - leftCount,
    )
    .map(([color]) => color);
  return { dominant: colors[0] ?? "#000000", colors };
}

function assignPixels(
  state: SemanticState,
  target: SemanticComponentInput,
  pixelIds: readonly number[],
  image: RgbaImage,
  layout: SkinLayout,
  provenance: SemanticComponentProvenance = userProvenance(),
  inheritDisplacedProvenance = true,
): SemanticState {
  validateComponentInput(target);
  if (pixelIds.length === 0) {
    throw new SemanticEditError("INVALID_SELECTION", "Assign selection is empty");
  }
  assertColoredSelection(image, pixelIds);
  const selection = new Set(pixelIds);
  const masks: Record<string, Uint8Array> = {};
  const components: SemanticComponent[] = [];
  const displacedProvenance: SemanticComponentProvenance[] = [];
  const removedComponentIds = new Set<string>();
  let existingTarget: SemanticComponent | undefined;

  for (const component of state.document.components) {
    const currentMask = state.masks[component.instanceId]!;
    if (component.instanceId === target.instanceId) {
      existingTarget = component;
      continue;
    }
    const remaining = maskToPixelIds(currentMask).filter(
      (pixelId) => !selection.has(pixelId),
    );
    if (remaining.length !== maskToPixelIds(currentMask).length) {
      displacedProvenance.push(component.provenance);
    }
    if (remaining.length > 0) {
      const mask = pixelIdsToMask(remaining);
      masks[component.instanceId] = mask;
      components.push(refreshComponent(component, mask, image, layout));
    } else {
      removedComponentIds.add(component.instanceId);
    }
  }

  const targetPixelIds = new Set(pixelIds);
  if (existingTarget) {
    for (const pixelId of maskToPixelIds(state.masks[target.instanceId]!)) {
      targetPixelIds.add(pixelId);
    }
  }
  const targetMask = pixelIdsToMask(targetPixelIds);
  const targetProvenance = inheritDisplacedProvenance
    ? combineProvenance([
        ...(existingTarget ? [existingTarget.provenance] : []),
        ...displacedProvenance,
        provenance,
      ])
    : provenance;
  masks[target.instanceId] = targetMask;
  components.push(
    refreshComponent(
      existingTarget ?? createComponent(target, targetProvenance),
      targetMask,
      image,
      layout,
      target,
      targetProvenance,
    ),
  );
  return finalizeState(
    state.document,
    rewriteRelationsAfterComponentRemoval(
      components,
      new Map(
        [...removedComponentIds].map((componentId) => [
          componentId,
          target.instanceId,
        ]),
      ),
    ),
    masks,
    image,
    layout,
  );
}

function unassignPixels(
  state: SemanticState,
  pixelIds: readonly number[],
  image: RgbaImage,
  layout: SkinLayout,
): SemanticState {
  if (pixelIds.length === 0) {
    throw new SemanticEditError("INVALID_SELECTION", "Unassign selection is empty");
  }
  assertColoredSelection(image, pixelIds);
  const selection = new Set(pixelIds);
  let removedPixelCount = 0;
  const components: SemanticComponent[] = [];
  const masks: Record<string, Uint8Array> = {};
  const removedComponentIds = new Set<string>();
  for (const component of state.document.components) {
    const current = maskToPixelIds(state.masks[component.instanceId]!);
    const remaining = current.filter((pixelId) => !selection.has(pixelId));
    removedPixelCount += current.length - remaining.length;
    if (remaining.length === 0) {
      removedComponentIds.add(component.instanceId);
      continue;
    }
    const mask = pixelIdsToMask(remaining);
    masks[component.instanceId] = mask;
    components.push(refreshComponent(component, mask, image, layout));
  }
  if (removedPixelCount === 0) {
    throw new SemanticEditError(
      "INVALID_SELECTION",
      "Unassign selection does not contain classified pixels",
    );
  }
  return finalizeState(
    state.document,
    rewriteRelationsAfterComponentRemoval(
      components,
      new Map(
        [...removedComponentIds].map((componentId) => [componentId, null]),
      ),
    ),
    masks,
    image,
    layout,
  );
}

function mergeComponents(
  state: SemanticState,
  componentIds: readonly string[],
  target: SemanticComponentInput,
  image: RgbaImage,
  layout: SkinLayout,
): SemanticState {
  validateComponentInput(target);
  const sourceIds = [...new Set(componentIds)];
  if (sourceIds.length < 2) {
    throw new SemanticEditError(
      "INVALID_SELECTION",
      "Merge requires at least two components",
    );
  }
  const sourceComponents = sourceIds.map((id) => findComponent(state, id));
  const mergedPixels = new Set<number>();
  for (const id of sourceIds) {
    for (const pixelId of maskToPixelIds(state.masks[id]!)) {
      mergedPixels.add(pixelId);
    }
  }
  const components = state.document.components.filter(
    (component) => !sourceIds.includes(component.instanceId),
  );
  if (
    components.some((component) => component.instanceId === target.instanceId)
  ) {
    throw new SemanticEditError(
      "INVALID_COMPONENT",
      `Merge target already exists: ${target.instanceId}`,
    );
  }
  const masks: Record<string, Uint8Array> = Object.fromEntries(
    Object.entries(state.masks)
      .filter(([id]) => !sourceIds.includes(id))
      .map(([id, mask]) => [id, mask.slice()]),
  );
  const targetMask = pixelIdsToMask(mergedPixels);
  masks[target.instanceId] = targetMask;
  components.push(
    refreshComponent(
      sourceComponents[0]!,
      targetMask,
      image,
      layout,
      target,
      combineProvenance(sourceComponents.map((component) => component.provenance)),
    ),
  );
  return finalizeState(
    state.document,
    rewriteRelationsAfterComponentRemoval(
      components,
      new Map(sourceIds.map((componentId) => [componentId, target.instanceId])),
    ),
    masks,
    image,
    layout,
  );
}

function splitComponent(
  state: SemanticState,
  sourceComponentId: string,
  target: SemanticComponentInput,
  pixelIds: readonly number[],
  image: RgbaImage,
  layout: SkinLayout,
): SemanticState {
  validateComponentInput(target);
  const source = findComponent(state, sourceComponentId);
  if (state.document.components.some((component) => component.instanceId === target.instanceId)) {
    throw new SemanticEditError(
      "INVALID_COMPONENT",
      `Split target already exists: ${target.instanceId}`,
    );
  }
  const sourcePixels = new Set(maskToPixelIds(state.masks[sourceComponentId]!));
  const selected = [...new Set(pixelIds)];
  if (
    selected.length === 0 ||
    selected.some((pixelId) => !sourcePixels.has(pixelId))
  ) {
    throw new SemanticEditError(
      "INVALID_SELECTION",
      "Split selection must be a non-empty subset of the source component",
    );
  }
  const selection = new Set(selected);
  const remaining = [...sourcePixels].filter((pixelId) => !selection.has(pixelId));
  if (remaining.length === 0) {
    throw new SemanticEditError(
      "INVALID_SELECTION",
      "Split must leave pixels in the source component",
    );
  }
  const masks: Record<string, Uint8Array> = Object.fromEntries(
    Object.entries(state.masks).map(([id, mask]) => [id, mask.slice()]),
  );
  const sourceMask = pixelIdsToMask(remaining);
  const targetMask = pixelIdsToMask(selected);
  masks[sourceComponentId] = sourceMask;
  masks[target.instanceId] = targetMask;
  const components = state.document.components
    .filter((component) => component.instanceId !== sourceComponentId)
    .concat(
      refreshComponent(source, sourceMask, image, layout),
      refreshComponent(
        createComponent(target, source.provenance),
        targetMask,
        image,
        layout,
        undefined,
        source.provenance,
      ),
    );
  return finalizeState(state.document, components, masks, image, layout);
}

function reclassifyComponent(
  state: SemanticState,
  componentId: string,
  category: SemanticComponent["category"],
  subtype: string | undefined,
  image: RgbaImage,
  layout: SkinLayout,
): SemanticState {
  if (!isSemanticCategory(category)) {
    throw new SemanticEditError("INVALID_COMPONENT", `Unknown category: ${category}`);
  }
  const source = findComponent(state, componentId);
  const mask = state.masks[componentId]!;
  const components = state.document.components.map((component) =>
    component.instanceId === componentId
      ? refreshComponent(
          { ...source, category, ...(subtype ? { subtype } : { subtype: undefined }) },
          mask,
          image,
          layout,
          undefined,
          source.provenance,
        )
      : component,
  );
  return finalizeState(state.document, components, state.masks, image, layout);
}

function setComponentRelations(
  state: SemanticState,
  componentId: string,
  relations: Required<ComponentRelations>,
  image: RgbaImage,
  layout: SkinLayout,
): SemanticState {
  findComponent(state, componentId);
  const componentIds = new Set(
    state.document.components.map((component) => component.instanceId),
  );
  const validateReference = (relation: string, value: string): void => {
    validateInstanceId(value);
    if (value === componentId) {
      throw new SemanticEditError(
        "INVALID_COMPONENT",
        `${relation} cannot reference the component itself: ${componentId}`,
      );
    }
    if (!componentIds.has(value)) {
      throw new SemanticEditError(
        "INVALID_COMPONENT",
        `${relation} component does not exist: ${value}`,
      );
    }
  };
  if (relations.attachedTo !== null) {
    validateReference("attachedTo", relations.attachedTo);
  }
  const pairedWith = canonicalRelationIds(
    "pairedWith",
    relations.pairedWith,
    validateReference,
  );
  const conflictsWith = canonicalRelationIds(
    "conflictsWith",
    relations.conflictsWith,
    validateReference,
  );
  const sameOutfitGroup = relations.sameOutfitGroup === null
    ? null
    : relations.sameOutfitGroup.trim();
  if (
    sameOutfitGroup !== null &&
    (sameOutfitGroup.length === 0 || sameOutfitGroup.length > 100)
  ) {
    throw new SemanticEditError(
      "INVALID_COMPONENT",
      "sameOutfitGroup must contain 1-100 characters or be null",
    );
  }

  const pairedSet = new Set(pairedWith);
  const conflictSet = new Set(conflictsWith);
  const components = state.document.components.map((component) => {
    if (component.instanceId === componentId) {
      return {
        ...component,
        relations: {
          attachedTo: relations.attachedTo,
          pairedWith,
          sameOutfitGroup,
          conflictsWith,
        },
      };
    }
    const peerPairedWith = new Set(component.relations.pairedWith);
    const peerConflictsWith = new Set(component.relations.conflictsWith ?? []);
    if (pairedSet.has(component.instanceId)) peerPairedWith.add(componentId);
    else peerPairedWith.delete(componentId);
    if (conflictSet.has(component.instanceId)) peerConflictsWith.add(componentId);
    else peerConflictsWith.delete(componentId);
    return {
      ...component,
      relations: {
        ...component.relations,
        pairedWith: [...peerPairedWith].sort(compareIds),
        ...(component.relations.conflictsWith !== undefined ||
            peerConflictsWith.size > 0
          ? { conflictsWith: [...peerConflictsWith].sort(compareIds) }
          : {}),
      },
    };
  });
  if (components.every((component, index) => relationsEqual(
    component.relations,
    state.document.components[index]!.relations,
  ))) {
    throw new SemanticEditError(
      "INVALID_SELECTION",
      "Component relation replacement does not change the semantic state",
    );
  }
  return finalizeState(state.document, components, state.masks, image, layout);
}

function canonicalRelationIds(
  relation: string,
  values: readonly string[],
  validate: (relation: string, value: string) => void,
): string[] {
  if (!Array.isArray(values)) {
    throw new SemanticEditError(
      "INVALID_COMPONENT",
      `${relation} must be an array`,
    );
  }
  for (const value of values) validate(relation, value);
  return [...new Set(values)].sort(compareIds);
}

function compareIds(left: string, right: string): number {
  return left.localeCompare(right);
}

function relationsEqual(
  left: ComponentRelations,
  right: ComponentRelations,
): boolean {
  const leftConflicts = left.conflictsWith ?? [];
  const rightConflicts = right.conflictsWith ?? [];
  return (
    left.attachedTo === right.attachedTo &&
    left.sameOutfitGroup === right.sameOutfitGroup &&
    left.pairedWith.length === right.pairedWith.length &&
    left.pairedWith.every((value, index) => value === right.pairedWith[index]) &&
    leftConflicts.length === rightConflicts.length &&
    leftConflicts.every((value, index) => value === rightConflicts[index])
  );
}

/**
 * Rewrites references when an operation removes component identities. Explicit
 * merge/assignment replacements keep peer links on the surviving identity;
 * deletion to Unknown removes them. Pair/conflict edges are then made
 * symmetric so a newly committed Revision cannot introduce a one-sided link.
 */
function rewriteRelationsAfterComponentRemoval(
  components: readonly SemanticComponent[],
  replacements: ReadonlyMap<string, string | null>,
): SemanticComponent[] {
  if (replacements.size === 0) return [...components];
  const componentIds = new Set(
    components.map((component) => component.instanceId),
  );
  const remap = (ownerId: string, referencedId: string): string | null => {
    const replacement = replacements.has(referencedId)
      ? replacements.get(referencedId)!
      : referencedId;
    return replacement !== null &&
        replacement !== ownerId &&
        componentIds.has(replacement)
      ? replacement
      : null;
  };
  const rewritten = components.map((component) => {
    const attachedTo = component.relations.attachedTo === null
      ? null
      : remap(component.instanceId, component.relations.attachedTo);
    const pairedWith = component.relations.pairedWith
      .map((componentId) => remap(component.instanceId, componentId))
      .filter((componentId): componentId is string => componentId !== null);
    const conflictsWith = (component.relations.conflictsWith ?? [])
      .map((componentId) => remap(component.instanceId, componentId))
      .filter((componentId): componentId is string => componentId !== null);
    return {
      ...component,
      relations: {
        ...component.relations,
        attachedTo,
        pairedWith: [...new Set(pairedWith)].sort(compareIds),
        ...(component.relations.conflictsWith !== undefined ||
            conflictsWith.length > 0
          ? { conflictsWith: [...new Set(conflictsWith)].sort(compareIds) }
          : {}),
      },
    };
  });
  const byId = new Map(
    rewritten.map((component) => [component.instanceId, component] as const),
  );
  const paired = new Map<string, Set<string>>();
  const conflicts = new Map<string, Set<string>>();
  for (const component of rewritten) {
    paired.set(component.instanceId, new Set(component.relations.pairedWith));
    conflicts.set(
      component.instanceId,
      new Set(component.relations.conflictsWith ?? []),
    );
  }
  for (const component of rewritten) {
    for (const peerId of paired.get(component.instanceId)!) {
      if (byId.has(peerId)) paired.get(peerId)!.add(component.instanceId);
    }
    for (const peerId of conflicts.get(component.instanceId)!) {
      if (byId.has(peerId)) conflicts.get(peerId)!.add(component.instanceId);
    }
  }
  return rewritten.map((component) => ({
    ...component,
    relations: {
      ...component.relations,
      pairedWith: [...paired.get(component.instanceId)!].sort(compareIds),
      ...(component.relations.conflictsWith !== undefined ||
          conflicts.get(component.instanceId)!.size > 0
        ? {
            conflictsWith: [
              ...conflicts.get(component.instanceId)!,
            ].sort(compareIds),
          }
        : {}),
    },
  }));
}

function finalizeState(
  document: SegmentationDocument,
  components: readonly SemanticComponent[],
  masks: Readonly<Record<string, Uint8Array>>,
  image: RgbaImage,
  layout: SkinLayout,
): SemanticState {
  const sortedComponents = [...components].sort((left, right) =>
    left.instanceId.localeCompare(right.instanceId),
  );
  const sortedMasks = Object.fromEntries(
    Object.entries(masks)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, mask]) => [id, mask.slice()]),
  );
  const occupied = new Int16Array(64 * 64);
  occupied.fill(-1);
  for (const [componentIndex, component] of sortedComponents.entries()) {
    for (const pixelId of maskToPixelIds(sortedMasks[component.instanceId]!)) {
      occupied[pixelId] = componentIndex;
    }
  }
  const unknownMask = unassignedVisibleMask(image, layout, occupied);
  const state: SemanticState = {
    document: {
      ...document,
      components: sortedComponents,
      unknown: {
        maskFile: UNKNOWN_MASK_FILE,
        pixelCount: maskToPixelIds(unknownMask).length,
      },
    },
    masks: sortedMasks,
    unknownMask,
  };
  validateSemanticState(state, image, layout);
  return state;
}

function createComponent(
  input: SemanticComponentInput,
  provenance: SemanticComponentProvenance = userProvenance(),
): SemanticComponent {
  return {
    ...input,
    confidence: 1,
    reviewState: "confirmed",
    maskFile: componentMaskFile(input.instanceId),
    spans: [],
    palette: { dominant: "#000000", colors: [] },
    relations: {
      attachedTo: null,
      pairedWith: [],
      sameOutfitGroup: null,
    },
    provenance,
  };
}

function refreshComponent(
  source: SemanticComponent,
  mask: Uint8Array,
  image: RgbaImage,
  layout: SkinLayout,
  override?: SemanticComponentInput,
  provenance?: SemanticComponentProvenance,
): SemanticComponent {
  const canonicalSpans = pixelIdsToSpans(maskToPixelIds(mask), layout);
  const selectedProvenance = provenance ?? source.provenance;
  const refreshedProvenance = spansEqual(source.spans, canonicalSpans)
    ? selectedProvenance
    : withoutOriginSummary(selectedProvenance);
  return {
    ...source,
    ...(override ?? {}),
    confidence: 1,
    reviewState: "confirmed",
    maskFile: componentMaskFile(override?.instanceId ?? source.instanceId),
    spans: canonicalSpans,
    palette: paletteForMask(image, mask),
    provenance: refreshedProvenance,
  };
}

function withoutOriginSummary(
  provenance: SemanticComponentProvenance,
): SemanticComponentProvenance {
  const { originSummary: _originSummary, ...legacySummary } = provenance;
  return legacySummary;
}

function userProvenance(): SemanticComponentProvenance {
  return { actorType: "user", containsGeneratedPixels: false };
}

function combineProvenance(
  values: readonly SemanticComponentProvenance[],
): SemanticComponentProvenance {
  const containsGeneratedPixels = values.some(
    (value) => value.containsGeneratedPixels,
  );
  const restorations = values.flatMap((value) =>
    value.restoration ? [value.restoration] : [],
  );
  const planHashes = [...new Set(restorations.map((value) => value.planHash))];
  if (restorations.length === 0 || planHashes.length !== 1) {
    return { actorType: "user", containsGeneratedPixels };
  }
  return {
    actorType: "user",
    containsGeneratedPixels,
    restoration: {
      kind: "composition_restoration",
      planHash: planHashes[0]!,
      candidateIds: sortedUniqueEvidenceIds(
        restorations.flatMap((value) => value.candidateIds),
      ),
      sourceRevisionIds: sortedUniqueEvidenceIds(
        restorations.flatMap((value) => value.sourceRevisionIds),
      ),
      sourceComponentIds: sortedUniqueEvidenceIds(
        restorations.flatMap((value) => value.sourceComponentIds),
      ),
    },
  };
}

function sortedUniqueEvidenceIds(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function validateProvenance(
  provenance: SemanticComponentProvenance,
  expectedPixelCount?: number,
): void {
  if (
    !["user", "ai", "system"].includes(provenance.actorType) ||
    typeof provenance.containsGeneratedPixels !== "boolean"
  ) {
    throw new SemanticEditError("INVALID_COMPONENT", "Component provenance is invalid");
  }
  const originSummary = provenance.originSummary;
  if (originSummary) {
    const counts = originSummary.counts;
    const countValues = [
      counts.source_visible,
      counts.manual_authored,
      counts.generated_completion,
      counts.legacy_mixed,
    ];
    if (
      Object.keys(originSummary).sort().join(",") !==
        "containsGeneratedPixels,counts" ||
      Object.keys(counts).sort().join(",") !==
        "generated_completion,legacy_mixed,manual_authored,source_visible" ||
      countValues.some(
        (value) =>
          !Number.isInteger(value) || value < 0 || value > 64 * 64,
      ) ||
      originSummary.containsGeneratedPixels !==
        (counts.generated_completion > 0) ||
      provenance.containsGeneratedPixels !==
        originSummary.containsGeneratedPixels ||
      (expectedPixelCount !== undefined &&
        countValues.reduce((total, value) => total + value, 0) !==
          expectedPixelCount)
    ) {
      throw new SemanticEditError(
        "INVALID_COMPONENT",
        "Component pixel origin summary is invalid",
      );
    }
  }
  if (
    provenance.aiRunId !== undefined &&
    (provenance.aiRunId.trim().length === 0 || provenance.aiRunId.length > 160)
  ) {
    throw new SemanticEditError("INVALID_COMPONENT", "AI provenance run id is invalid");
  }
  const restoration = provenance.restoration;
  if (!restoration) return;
  if (
    restoration.kind !== "composition_restoration" ||
    !/^sha256:[0-9a-f]{64}$/u.test(restoration.planHash) ||
    !validEvidenceIds(restoration.candidateIds, true) ||
    !validEvidenceIds(restoration.sourceRevisionIds, false) ||
    !validEvidenceIds(restoration.sourceComponentIds, false)
  ) {
    throw new SemanticEditError(
      "INVALID_COMPONENT",
      "Composition restoration provenance is invalid",
    );
  }
}

function validEvidenceIds(
  values: readonly string[],
  requireOne: boolean,
): boolean {
  return (
    Array.isArray(values) &&
    (!requireOne || values.length > 0) &&
    new Set(values).size === values.length &&
    values.every((value) =>
      typeof value === "string" && value.trim().length > 0 && value.length <= 200
    )
  );
}

function findComponent(state: SemanticState, componentId: string): SemanticComponent {
  const component = state.document.components.find(
    (candidate) => candidate.instanceId === componentId,
  );
  if (!component) {
    throw new SemanticEditError(
      "INVALID_COMPONENT",
      `Component does not exist: ${componentId}`,
    );
  }
  return component;
}

function validateComponentInput(
  input: Pick<SemanticComponentInput, "instanceId" | "displayName" | "category">,
): void {
  validateInstanceId(input.instanceId);
  if (
    input.displayName.trim().length === 0 ||
    input.displayName.trim().length > 80
  ) {
    throw new SemanticEditError(
      "INVALID_COMPONENT",
      "Component displayName must contain 1-80 characters",
    );
  }
  if (!isSemanticCategory(input.category)) {
    throw new SemanticEditError(
      "INVALID_COMPONENT",
      `Unknown category: ${input.category}`,
    );
  }
}

function validateInstanceId(instanceId: string): void {
  if (
    instanceId === "unknown" ||
    !INSTANCE_ID_PATTERN.test(instanceId) ||
    instanceId.length > 100
  ) {
    throw new SemanticEditError(
      "INVALID_COMPONENT",
      `Unsafe component id: ${instanceId}`,
    );
  }
}

function visibleUsedPixelIds(image: RgbaImage, layout: SkinLayout): number[] {
  if (image.width !== 64 || image.height !== 64) {
    throw new SemanticEditError("INVALID_SELECTION", "Semantic image must be 64x64");
  }
  const pixelIds: number[] = [];
  for (const surfaceKey of layout.surfaceOrder) {
    const { atlasRect } = layout.surfaces[surfaceKey];
    for (let y = atlasRect.y; y < atlasRect.y + atlasRect.height; y += 1) {
      for (let x = atlasRect.x; x < atlasRect.x + atlasRect.width; x += 1) {
        const pixelId = y * 64 + x;
        if (image.data[pixelId * 4 + 3] !== 0) {
          pixelIds.push(pixelId);
        }
      }
    }
  }
  return [...new Set(pixelIds)].sort((left, right) => left - right);
}

function unassignedVisibleMask(
  image: RgbaImage,
  layout: SkinLayout,
  occupied: Int16Array,
): Uint8Array {
  return pixelIdsToMask(
    visibleUsedPixelIds(image, layout).filter(
      (pixelId) => occupied[pixelId] === -1,
    ),
  );
}

function assertColoredSelection(
  image: RgbaImage,
  pixelIds: readonly number[],
): void {
  const transparentPixelId = pixelIds.find(
    (pixelId) => image.data[pixelId * 4 + 3] === 0,
  );
  if (transparentPixelId !== undefined) {
    throw new SemanticEditError(
      "INVALID_SELECTION",
      `Selection contains transparent pixel ${transparentPixelId}`,
    );
  }
}

function masksEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function spansEqual(
  left: readonly SemanticComponent["spans"][number][],
  right: readonly SemanticComponent["spans"][number][],
): boolean {
  return (
    left.length === right.length &&
    left.every((span, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        span.surface === other.surface &&
        span.y === other.y &&
        span.x0 === other.x0 &&
        span.x1 === other.x1
      );
    })
  );
}

function palettesEqual(
  left: SemanticComponent["palette"],
  right: SemanticComponent["palette"],
): boolean {
  return (
    left.dominant === right.dominant &&
    left.colors.length === right.colors.length &&
    left.colors.every((color, index) => color === right.colors[index])
  );
}

function hex(value: number): string {
  return value.toString(16).padStart(2, "0").toUpperCase();
}
