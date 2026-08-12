import {
  assertMask,
  createRgbaImage,
  getSkinLayout,
  maskToPixelIds,
  type Rgba,
  type RgbaImage,
  type SurfaceKey,
} from "@mc-skin-split/skin-core";
import {
  COMPOSITION_BASE_LAYER_ID,
  type ComposeSkinInput,
  type CompositionConflict,
  type CompositionLayerInput,
  type CompositionPixelConflict,
  type CompositionPixelWrite,
  type CompositionRestorationOperation,
  type CompositionResult,
} from "./types";

const PIXEL_COUNT = 64 * 64;

interface PreparedLayer extends CompositionLayerInput {
  readonly allowedPixelIds: ReadonlySet<number>;
}

interface PreparedRestoration {
  readonly image: RgbaImage;
  readonly pixelIdsByOperation: Readonly<Record<string, readonly number[]>>;
  readonly pixelCount: number;
  readonly outerPixelCount: number;
  readonly basePixelCount: number;
}

export function composeSkin(input: ComposeSkinInput): CompositionResult {
  assertImage(input.base, "base");
  const restorationMissingPixelCount = assertNonNegativeCount(
    input.restorationAssessment?.missingPixelCount ?? 0,
    "Restoration missing pixel count",
  );
  const restorationIssueCount = assertNonNegativeCount(
    input.restorationAssessment?.issueCount ?? 0,
    "Restoration issue count",
  );
  const layers = prepareLayers(input.layers, input.targetArmType);
  const restoration = prepareRestoration(
    input.base,
    input.restorationPlan?.operations ?? [],
    input.targetArmType,
  );
  const resolutionMode = input.resolutionMode ?? "unresolved";
  const conflictWinners = input.conflictWinners ?? {};
  const writesByPixel = Array.from(
    { length: PIXEL_COUNT },
    () => [] as CompositionPixelWrite[],
  );
  const conflicts: CompositionConflict[] = [];
  let modelConflictCount = 0;
  let unknownConflictCount = 0;

  for (const layer of layers) {
    if (!layer.manifest.compatibility.armTypes.includes(input.targetArmType)) {
      modelConflictCount += 1;
      conflicts.push({
        id: `model:${layer.layerId}`,
        type: "model_conflict",
        blocking: true,
        resolved: false,
        layerId: layer.layerId,
        partId: layer.partId,
        targetArmType: input.targetArmType,
        supportedArmTypes: [...layer.manifest.compatibility.armTypes],
      });
      continue;
    }

    const unknownPixelIds: number[] = [];
    for (const pixelId of maskToPixelIds(layer.writeMask)) {
      if (!layer.allowedPixelIds.has(pixelId)) {
        unknownPixelIds.push(pixelId);
        continue;
      }
      const rgba = readRgba(layer.texture, pixelId);
      if (rgba[3] === 0) {
        throw new RangeError(
          `Layer ${layer.layerId} writes transparent pixel ${pixelId} with colored-only mask mode`,
        );
      }
      writesByPixel[pixelId]!.push({
        layerId: layer.layerId,
        partId: layer.partId,
        position: layer.position,
        rgba,
      });
    }
    if (unknownPixelIds.length > 0) {
      unknownConflictCount += unknownPixelIds.length;
      conflicts.push({
        id: `unknown:${layer.layerId}`,
        type: "unknown_conflict",
        blocking: true,
        resolved: false,
        layerId: layer.layerId,
        partId: layer.partId,
        pixelIds: unknownPixelIds,
      });
    }
  }

  const resultData = restoration.image.data.slice();
  const winningPixelIds = new Map<string, number[]>();
  let writePixelCount = 0;
  let appliedPixelCount = 0;
  let hardConflictCount = 0;
  let sameColorOverlapCount = 0;
  let layerConflictCount = 0;

  for (let pixelId = 0; pixelId < PIXEL_COUNT; pixelId += 1) {
    const partWrites = writesByPixel[pixelId]!;
    if (partWrites.length === 0) continue;
    writePixelCount += 1;
    if (partWrites.length > 1) layerConflictCount += 1;
    const writes = withBaseWrite(restoration.image, pixelId, partWrites);
    let winner = partWrites[partWrites.length - 1]!;

    if (writes.length > 1) {
      const allSame = writes.every((write) => rgbaEqual(write.rgba, writes[0]!.rgba));
      const type = allSame ? "same_color_overlap" : "hard_conflict";
      const conflictId = `pixel:${pixelId}`;
      const requestedWinner = conflictWinners[conflictId];
      if (
        requestedWinner !== undefined &&
        !writes.some((write) => write.layerId === requestedWinner)
      ) {
        throw new RangeError(
          `Conflict ${conflictId} cannot be won by unavailable layer ${requestedWinner}`,
        );
      }
      const defaultWinner = writes[writes.length - 1]!;
      const resolved =
        allSame || requestedWinner !== undefined || resolutionMode === "layer_order";
      const winnerLayerId = requestedWinner ?? defaultWinner.layerId;
      const selected = writes.find((write) => write.layerId === winnerLayerId)!;
      const conflict: CompositionPixelConflict = {
        id: conflictId,
        type,
        blocking: !allSame,
        resolved,
        pixelId,
        x: pixelId % 64,
        y: Math.floor(pixelId / 64),
        writes,
        defaultWinnerLayerId: defaultWinner.layerId,
        winnerLayerId,
      };
      conflicts.push(conflict);
      if (allSame) sameColorOverlapCount += 1;
      else hardConflictCount += 1;
      winner = selected;
    }

    if (winner.layerId === COMPOSITION_BASE_LAYER_ID) continue;
    writeRgba(resultData, pixelId, winner.rgba);
    appliedPixelCount += 1;
    const ids = winningPixelIds.get(winner.layerId) ?? [];
    ids.push(pixelId);
    winningPixelIds.set(winner.layerId, ids);
  }

  const knownConflictIds = new Set(conflicts.map((conflict) => conflict.id));
  for (const conflictId of Object.keys(conflictWinners)) {
    if (!knownConflictIds.has(conflictId)) {
      throw new RangeError(`Conflict resolution references unknown conflict ${conflictId}`);
    }
  }
  conflicts.sort(compareConflicts);
  const unresolvedConflictCount = conflicts.filter(
    (conflict) => conflict.blocking && !conflict.resolved,
  ).length;

  return {
    image: createRgbaImage(64, 64, resultData),
    report: {
      targetArmType: input.targetArmType,
      layerCount: layers.length,
      writePixelCount,
      appliedPixelCount,
      hardConflictCount,
      sameColorOverlapCount,
      layerConflictCount,
      modelConflictCount,
      unknownConflictCount,
      restorationPixelCount: restoration.pixelCount,
      restoredOuterPixelCount: restoration.outerPixelCount,
      restoredBasePixelCount: restoration.basePixelCount,
      restorationMissingPixelCount,
      restorationIssueCount,
      unresolvedConflictCount,
      committable:
        (layers.length > 0 || restoration.pixelCount > 0) &&
        unresolvedConflictCount === 0 &&
        restorationMissingPixelCount === 0 &&
        restorationIssueCount === 0,
      conflicts,
    },
    winningPixelIdsByLayer: Object.fromEntries(
      [...winningPixelIds].map(([layerId, pixelIds]) => [layerId, pixelIds]),
    ),
    restoredPixelIdsByOperation: restoration.pixelIdsByOperation,
  };
}

function prepareRestoration(
  base: RgbaImage,
  operations: readonly CompositionRestorationOperation[],
  armType: "wide" | "slim",
): PreparedRestoration {
  const image = createRgbaImage(64, 64, base.data.slice());
  const layout = getSkinLayout(armType);
  const layerByPixel = new Map<number, "base" | "outer">();
  for (const surfaceKey of layout.surfaceOrder) {
    const surface = layout.surfaces[surfaceKey];
    if (!surface) continue;
    const rect = surface.atlasRect;
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) {
        layerByPixel.set(y * 64 + x, surface.layer);
      }
    }
  }

  const operationIds = new Set<string>();
  const occupied = new Map<number, string>();
  const pixelIdsByOperation: Record<string, readonly number[]> = {};
  let outerPixelCount = 0;
  let basePixelCount = 0;

  for (const operation of operations) {
    if (!/^[a-z][a-z0-9_-]{2,100}$/u.test(operation.operationId)) {
      throw new TypeError(`Unsafe restoration operation id: ${operation.operationId}`);
    }
    if (operationIds.has(operation.operationId)) {
      throw new TypeError(`Duplicate restoration operation id: ${operation.operationId}`);
    }
    operationIds.add(operation.operationId);
    assertMask(operation.mask);
    const pixelIds = maskToPixelIds(operation.mask);
    if (pixelIds.length === 0) {
      throw new RangeError(`Restoration operation ${operation.operationId} mask is empty`);
    }

    if (operation.mode === "fill_base") {
      assertRgba(operation.rgba, `Restoration operation ${operation.operationId}`);
      if (operation.rgba[3] !== 255) {
        throw new RangeError(
          `Restoration operation ${operation.operationId} must use an opaque Base fill`,
        );
      }
    }

    for (const pixelId of pixelIds) {
      const previous = occupied.get(pixelId);
      if (previous) {
        throw new RangeError(
          `Restoration operations ${previous} and ${operation.operationId} overlap pixel ${pixelId}`,
        );
      }
      occupied.set(pixelId, operation.operationId);
      const layer = layerByPixel.get(pixelId);
      if (!layer) {
        throw new RangeError(
          `Restoration operation ${operation.operationId} targets unused UV pixel ${pixelId}`,
        );
      }
      if (operation.mode === "clear_outer") {
        if (layer !== "outer") {
          throw new RangeError(
            `Restoration operation ${operation.operationId} cannot clear Base pixel ${pixelId}`,
          );
        }
        writeRgba(image.data, pixelId, [0, 0, 0, 0]);
        outerPixelCount += 1;
      } else {
        if (layer !== "base") {
          throw new RangeError(
            `Restoration operation ${operation.operationId} cannot fill Outer pixel ${pixelId}`,
          );
        }
        writeRgba(image.data, pixelId, operation.rgba);
        basePixelCount += 1;
      }
    }
    pixelIdsByOperation[operation.operationId] = pixelIds;
  }

  return {
    image,
    pixelIdsByOperation,
    pixelCount: occupied.size,
    outerPixelCount,
    basePixelCount,
  };
}

function prepareLayers(
  inputs: readonly CompositionLayerInput[],
  targetArmType: "wide" | "slim",
): PreparedLayer[] {
  const layerIds = new Set<string>();
  return inputs
    .map((layer) => {
      if (!/^[a-z][a-z0-9_-]{2,100}$/u.test(layer.layerId)) {
        throw new TypeError(`Unsafe composition layer id: ${layer.layerId}`);
      }
      if (layerIds.has(layer.layerId)) {
        throw new TypeError(`Duplicate composition layer id: ${layer.layerId}`);
      }
      layerIds.add(layer.layerId);
      if (!Number.isInteger(layer.position) || layer.position < 0) {
        throw new RangeError(`Layer position must be a non-negative integer: ${layer.position}`);
      }
      if (layer.manifest.id !== layer.partId) {
        throw new TypeError(`Layer ${layer.layerId} part and manifest ids differ`);
      }
      if (layer.manifest.maskMode !== "write-colored-pixels-only") {
        throw new TypeError(`Unsupported part mask mode: ${layer.manifest.maskMode}`);
      }
      assertImage(layer.texture, `layer ${layer.layerId}`);
      assertMask(layer.writeMask);
      return {
        ...layer,
        allowedPixelIds: surfacePixelIds(
          layer.manifest.placement.surfaces,
          targetArmType,
        ),
      };
    })
    .sort((left, right) =>
      left.position === right.position
        ? left.layerId.localeCompare(right.layerId)
        : left.position - right.position,
    );
}

function surfacePixelIds(
  surfaces: readonly SurfaceKey[],
  armType: "wide" | "slim",
): ReadonlySet<number> {
  const layout = getSkinLayout(armType);
  const pixels = new Set<number>();
  for (const key of surfaces) {
    const surface = layout.surfaces[key];
    if (!surface) throw new RangeError(`Unknown part surface: ${key}`);
    const rect = surface.atlasRect;
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) {
        pixels.add(y * 64 + x);
      }
    }
  }
  return pixels;
}

function withBaseWrite(
  base: RgbaImage,
  pixelId: number,
  partWrites: readonly CompositionPixelWrite[],
): CompositionPixelWrite[] {
  const baseRgba = readRgba(base, pixelId);
  return [
    ...(baseRgba[3] === 0
      ? []
      : [
          {
            layerId: COMPOSITION_BASE_LAYER_ID,
            partId: null,
            position: -1,
            rgba: baseRgba,
          } satisfies CompositionPixelWrite,
        ]),
    ...partWrites,
  ];
}

function assertImage(image: RgbaImage, label: string): void {
  if (image.width !== 64 || image.height !== 64 || image.data.length !== PIXEL_COUNT * 4) {
    throw new RangeError(`Composition ${label} image must be 64x64 RGBA`);
  }
}

function assertRgba(rgba: Rgba, label: string): void {
  if (
    rgba.length !== 4 ||
    rgba.some(
      (value) => !Number.isInteger(value) || value < 0 || value > 255,
    )
  ) {
    throw new RangeError(`${label} RGBA values must be integers from 0 to 255`);
  }
}

function assertNonNegativeCount(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer`);
  }
  return value;
}

function readRgba(image: RgbaImage, pixelId: number): Rgba {
  const offset = pixelId * 4;
  return [
    image.data[offset]!,
    image.data[offset + 1]!,
    image.data[offset + 2]!,
    image.data[offset + 3]!,
  ];
}

function writeRgba(data: Uint8Array, pixelId: number, rgba: Rgba): void {
  data.set(rgba, pixelId * 4);
}

function rgbaEqual(left: Rgba, right: Rgba): boolean {
  return left.every((value, index) => value === right[index]);
}

function compareConflicts(left: CompositionConflict, right: CompositionConflict): number {
  const leftPixel = "pixelId" in left ? left.pixelId : Number.MAX_SAFE_INTEGER;
  const rightPixel = "pixelId" in right ? right.pixelId : Number.MAX_SAFE_INTEGER;
  if (leftPixel !== rightPixel) return leftPixel - rightPixel;
  return left.id.localeCompare(right.id);
}
