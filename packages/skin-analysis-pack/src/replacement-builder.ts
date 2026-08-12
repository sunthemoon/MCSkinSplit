import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type {
  BuildReplacementPlanningPackInput,
  PublicRestorationCandidate,
  PublicRestorationCandidateCatalog,
  ReplacementPlanningPack,
  ReplacementPlanningPackManifest,
  ReplacementPlanningPackPaths,
} from "./replacement-types";
import { REPLACEMENT_PLANNING_PROMPT_VERSION } from "./replacement-types";

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const CANDIDATE_ID_PATTERN = /^restore_[0-9a-f]{64}$/u;
const TARGET_GROUP_PATTERN =
  /^(head|torso|leftArm|rightArm|leftLeg|rightLeg)_base$/u;
const JOB_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,119}$/u;
const COMPONENT_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const BASE_KINDS = new Set([
  "current_same_surface",
  "current_same_body_part",
  "mirrored_counterpart",
  "donor_revision",
  "manual_rgba",
]);
const PATHS: ReplacementPlanningPackPaths = {
  candidateCatalog: "input/restoration-candidates.json",
  manifest: "input/manifest.json",
  outputSchema: "schema/replacement-plan.schema.json",
  proposal: "output/replacement-plan.json",
  validatorReport: "logs/validator-report.json",
  previousValidatorReport: "logs/previous-validator-report.json",
};

export async function buildReplacementPlanningPack(
  input: BuildReplacementPlanningPackInput,
): Promise<ReplacementPlanningPack> {
  assertReplacementPackInput(input);
  const root = resolve(input.workspaceDirectory);
  const job = {
    schemaVersion: "1.0" as const,
    jobId: input.jobId,
    userIntent: input.userIntent,
  };
  const files: Record<string, Uint8Array> = {
    "job.json": utf8(canonicalJson(job)),
    [PATHS.candidateCatalog]: utf8(canonicalJson(input.candidateCatalog)),
    [PATHS.outputSchema]: utf8(canonicalJson(input.proposalSchema)),
  };
  const skillFiles = await readSkillFiles(input.skillDirectory);
  for (const [relativePath, bytes] of Object.entries(skillFiles)) {
    files[`.agents/skills/mc-skin-replacement-planner/${relativePath}`] = bytes;
  }

  await Promise.all([
    mkdir(resolveWithin(root, "input"), { recursive: true }),
    mkdir(resolveWithin(root, "output"), { recursive: true }),
    mkdir(resolveWithin(root, "logs"), { recursive: true }),
  ]);
  for (const [relativePath, bytes] of Object.entries(files)) {
    const path = resolveWithin(root, ...relativePath.split("/"));
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, bytes, { flag: "wx" });
  }

  const fileHashes = Object.fromEntries(
    Object.entries(files)
      .sort(([left], [right]) => compareString(left, right))
      .map(([path, bytes]) => [path, sha256(bytes)]),
  );
  const cacheFiles = Object.fromEntries(
    Object.entries(fileHashes).filter(([path]) => path !== "job.json"),
  );
  const inputHash = sha256(
    utf8(
      canonicalJson({
        candidateSetHash: input.candidateCatalog.candidateSetHash,
        userIntent: input.userIntent,
        skillVersion: input.skillVersion,
        promptVersion: REPLACEMENT_PLANNING_PROMPT_VERSION,
        provider: input.provider,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        files: cacheFiles,
      }),
    ),
  );
  const manifest: ReplacementPlanningPackManifest = {
    schemaVersion: "1.0",
    inputHash,
    files: fileHashes,
  };
  const manifestBytes = utf8(canonicalJson(manifest));
  await writeFile(resolveWithin(root, ...PATHS.manifest.split("/")), manifestBytes, {
    flag: "wx",
  });

  return {
    workspaceDirectory: root,
    job,
    candidateCatalog: input.candidateCatalog,
    inputHash,
    fileHashes,
    manifestHash: sha256(manifestBytes),
    paths: PATHS,
    imagePaths: [],
  };
}

export async function verifyReplacementPlanningPackIntegrity(
  pack: ReplacementPlanningPack,
): Promise<void> {
  const manifestPath = resolveWithin(
    pack.workspaceDirectory,
    ...pack.paths.manifest.split("/"),
  );
  let manifestBytes: Uint8Array;
  try {
    manifestBytes = new Uint8Array(await readFile(manifestPath));
  } catch (error) {
    throw new Error("Replacement planning manifest is missing", { cause: error });
  }
  if (sha256(manifestBytes) !== pack.manifestHash) {
    throw new Error("Replacement planning manifest changed during provider run");
  }
  let manifest: ReplacementPlanningPackManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as
      ReplacementPlanningPackManifest;
  } catch (error) {
    throw new Error("Replacement planning manifest is invalid", { cause: error });
  }
  if (
    manifest.schemaVersion !== "1.0" ||
    manifest.inputHash !== pack.inputHash ||
    canonicalJson(manifest.files) !== canonicalJson(pack.fileHashes)
  ) {
    throw new Error("Replacement planning manifest does not match the pack");
  }

  for (const [relativePath, expectedHash] of Object.entries(pack.fileHashes)) {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(
        await readFile(
          resolveWithin(pack.workspaceDirectory, ...relativePath.split("/")),
        ),
      );
    } catch (error) {
      throw new Error(`Replacement planning input file is missing: ${relativePath}`, {
        cause: error,
      });
    }
    if (sha256(bytes) !== expectedHash) {
      throw new Error(
        `Replacement planning input file changed during provider run: ${relativePath}`,
      );
    }
  }
}

export function assertPublicRestorationCandidateCatalog(
  value: PublicRestorationCandidateCatalog,
): void {
  assertExactKeys(
    value,
    [
      "compositionId",
      "version",
      "candidateSetHash",
      "targetComponentIds",
      "outer",
      "base",
    ],
    "candidate catalog",
  );
  const catalogRecord = value as unknown as Readonly<Record<string, unknown>>;
  if ("mask" in catalogRecord || "pixelIds" in catalogRecord || "operations" in catalogRecord) {
    throw new TypeError("candidate catalog contains private restoration evidence");
  }
  assertText(value.compositionId, 3, 120, "compositionId");
  if (!isNonNegativeInteger(value.version)) {
    throw new TypeError("version must be a non-negative integer");
  }
  if (!HASH_PATTERN.test(value.candidateSetHash)) {
    throw new TypeError("candidateSetHash is invalid");
  }
  assertUniqueStrings(value.targetComponentIds, "targetComponentIds", {
    minimumItems: 1,
    pattern: COMPONENT_ID_PATTERN,
    maximumLength: 100,
  });

  assertExactKeys(value.outer, ["pixelCount", "candidateId"], "outer");
  if (!isNonNegativeInteger(value.outer.pixelCount)) {
    throw new TypeError("outer.pixelCount must be a non-negative integer");
  }
  if (
    value.outer.candidateId !== null &&
    !CANDIDATE_ID_PATTERN.test(value.outer.candidateId)
  ) {
    throw new TypeError("outer.candidateId is invalid");
  }
  if ((value.outer.pixelCount === 0) !== (value.outer.candidateId === null)) {
    throw new TypeError("outer candidate identity does not match its pixel count");
  }

  assertExactKeys(
    value.base,
    ["pixelCount", "coveredPixelCount", "missingPixelCount", "candidates"],
    "base",
  );
  for (const [name, count] of Object.entries({
    pixelCount: value.base.pixelCount,
    coveredPixelCount: value.base.coveredPixelCount,
    missingPixelCount: value.base.missingPixelCount,
  })) {
    if (!isNonNegativeInteger(count)) {
      throw new TypeError(`base.${name} must be a non-negative integer`);
    }
  }
  if (
    value.base.coveredPixelCount > value.base.pixelCount ||
    value.base.missingPixelCount !==
      value.base.pixelCount - value.base.coveredPixelCount
  ) {
    throw new TypeError("base coverage counts are inconsistent");
  }
  if (!Array.isArray(value.base.candidates)) {
    throw new TypeError("base.candidates must be an array");
  }

  const candidateIds = new Set<string>();
  const groupPixelCounts = new Map<string, number>();
  for (const [index, candidate] of value.base.candidates.entries()) {
    assertPublicCandidate(candidate, index);
    if (candidateIds.has(candidate.id)) {
      throw new TypeError(`duplicate candidate ID: ${candidate.id}`);
    }
    candidateIds.add(candidate.id);
    if (candidate.id === value.outer.candidateId) {
      throw new TypeError("aggregate Outer candidate must not appear in Base candidates");
    }
    const previousPixelCount = groupPixelCounts.get(candidate.targetGroupId);
    if (
      previousPixelCount !== undefined &&
      previousPixelCount !== candidate.pixelCount
    ) {
      throw new TypeError(
        `Base candidates disagree on pixelCount for ${candidate.targetGroupId}`,
      );
    }
    groupPixelCounts.set(candidate.targetGroupId, candidate.pixelCount);
  }
  const groupedPixelCount = [...groupPixelCounts.values()].reduce(
    (total, count) => total + count,
    0,
  );
  if (groupedPixelCount !== value.base.pixelCount) {
    throw new TypeError(
      "public candidate catalog does not expose every Base target group",
    );
  }
}

function assertReplacementPackInput(
  input: BuildReplacementPlanningPackInput,
): void {
  if (!JOB_ID_PATTERN.test(input.jobId)) throw new TypeError("jobId is invalid");
  assertText(input.userIntent, 1, 1_000, "userIntent");
  if (input.userIntent.includes("\0")) {
    throw new TypeError("userIntent contains a null character");
  }
  assertText(input.skillVersion, 1, 80, "skillVersion");
  assertText(input.provider, 1, 80, "provider");
  assertText(input.model, 1, 120, "model");
  if (!["low", "medium", "high", "xhigh", "max"].includes(input.reasoningEffort)) {
    throw new TypeError("reasoningEffort is invalid");
  }
  assertPublicRestorationCandidateCatalog(input.candidateCatalog);
  if (!isPlainObject(input.proposalSchema)) {
    throw new TypeError("proposalSchema must be a JSON object");
  }
}

function assertPublicCandidate(
  candidate: PublicRestorationCandidate,
  index: number,
): void {
  const label = `base.candidates[${index}]`;
  assertExactKeys(
    candidate,
    [
      "id",
      "kind",
      "targetGroupId",
      "label",
      "description",
      "pixelCount",
      "coveragePixelCount",
    ],
    label,
    ["sourceRevisionId", "rgba", "selectedByDefault"],
  );
  if (!CANDIDATE_ID_PATTERN.test(candidate.id)) {
    throw new TypeError(`${label}.id is invalid`);
  }
  if (!BASE_KINDS.has(candidate.kind)) {
    throw new TypeError(`${label}.kind is invalid`);
  }
  if (!TARGET_GROUP_PATTERN.test(candidate.targetGroupId)) {
    throw new TypeError(`${label}.targetGroupId is invalid`);
  }
  assertText(candidate.label, 1, 120, `${label}.label`);
  assertText(candidate.description, 1, 500, `${label}.description`);
  if (!Number.isInteger(candidate.pixelCount) || candidate.pixelCount < 1) {
    throw new TypeError(`${label}.pixelCount must be a positive integer`);
  }
  if (
    !isNonNegativeInteger(candidate.coveragePixelCount) ||
    candidate.coveragePixelCount > candidate.pixelCount
  ) {
    throw new TypeError(`${label}.coveragePixelCount is invalid`);
  }
  if (candidate.sourceRevisionId !== undefined) {
    assertText(candidate.sourceRevisionId, 1, 120, `${label}.sourceRevisionId`);
  }
  if (
    candidate.selectedByDefault !== undefined &&
    typeof candidate.selectedByDefault !== "boolean"
  ) {
    throw new TypeError(`${label}.selectedByDefault must be boolean`);
  }
  if (candidate.kind === "manual_rgba") assertOpaqueRgba(candidate.rgba, label);
  else if (candidate.rgba !== undefined) {
    throw new TypeError(`${label}.rgba is only valid for manual_rgba`);
  }
}

async function readSkillFiles(
  skillDirectory: string,
): Promise<Record<string, Uint8Array>> {
  const root = resolve(skillDirectory);
  const result: Record<string, Uint8Array> = {};
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      compareString(left.name, right.name),
    )) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new TypeError(`Replacement planner Skill cannot contain symlinks: ${path}`);
      }
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const relativePath = relative(root, path).split(sep).join("/");
        result[relativePath] = new Uint8Array(await readFile(path));
      } else {
        throw new TypeError(`Replacement planner Skill contains unsupported entry: ${path}`);
      }
    }
  }
  await visit(root);
  if (!("SKILL.md" in result)) {
    throw new TypeError("Replacement planner Skill is missing SKILL.md");
  }
  return result;
}

function assertOpaqueRgba(value: unknown, label: string): void {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    value.some(
      (channel) =>
        !Number.isInteger(channel) ||
        (channel as number) < 0 ||
        (channel as number) > 255,
    ) ||
    value[3] !== 255
  ) {
    throw new TypeError(`${label}.rgba must contain four bytes with alpha 255`);
  }
}

function assertUniqueStrings(
  value: readonly string[],
  label: string,
  options: {
    readonly minimumItems: number;
    readonly maximumLength: number;
    readonly pattern: RegExp;
  },
): void {
  if (!Array.isArray(value) || value.length < options.minimumItems) {
    throw new TypeError(`${label} must be a non-empty array`);
  }
  const seen = new Set<string>();
  for (const item of value) {
    if (
      typeof item !== "string" ||
      item.length > options.maximumLength ||
      !options.pattern.test(item)
    ) {
      throw new TypeError(`${label} contains an invalid ID`);
    }
    if (seen.has(item)) throw new TypeError(`${label} contains duplicate ID: ${item}`);
    seen.add(item);
  }
}

function assertExactKeys(
  value: unknown,
  requiredKeys: readonly string[],
  label: string,
  optionalKeys: readonly string[] = [],
): asserts value is Readonly<Record<string, unknown>> {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be an object`);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  for (const key of requiredKeys) {
    if (!(key in value)) throw new TypeError(`${label} is missing ${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new TypeError(`${label} contains unsupported field: ${key}`);
    }
  }
}

function assertText(value: unknown, minimum: number, maximum: number, label: string): void {
  if (
    typeof value !== "string" ||
    value.trim().length < minimum ||
    value.length > maximum
  ) {
    throw new TypeError(`${label} must contain ${minimum}-${maximum} characters`);
  }
}

function resolveWithin(root: string, ...segments: string[]): string {
  const candidate = resolve(root, ...segments);
  const relation = relative(root, candidate);
  if (relation === ".." || relation.startsWith(`..${sep}`)) {
    throw new TypeError(`Replacement planning path escapes workspace: ${candidate}`);
  }
  return candidate;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => compareString(left, right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function compareString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
