const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const CANDIDATE_ID_PATTERN = /^restore_[0-9a-f]{64}$/u;
const TARGET_GROUP_PATTERN = /^(head|torso|leftArm|rightArm|leftLeg|rightLeg)_base$/u;
const JOB_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,119}$/u;
const BASE_KINDS = new Set([
  "current_same_surface",
  "current_same_body_part",
  "mirrored_counterpart",
  "donor_revision",
  "manual_rgba",
]);
const FORBIDDEN_PROSE = [
  /\bmask\b/iu,
  /\bpixel\s*ids?\b/iu,
  /\bcoordinates?\b/iu,
  /\brgba?\b/iu,
  /\bpng\b/iu,
  /像素\s*(?:id|编号)/iu,
  /坐标/iu,
  /遮罩/iu,
  /\[[ ]*\d{1,3}(?:[ ]*,[ ]*\d{1,3}){3}[ ]*\]/u,
  /#[0-9a-f]{6,8}\b/iu,
];

export function validateJob(job) {
  const errors = [];
  if (!plainObject(job)) return ["job.json must contain a JSON object"];
  exactKeys(job, ["schemaVersion", "jobId", "userIntent"], "job.json", errors);
  if (job.schemaVersion !== "1.0") errors.push("job.schemaVersion must be 1.0");
  if (typeof job.jobId !== "string" || !JOB_ID_PATTERN.test(job.jobId)) {
    errors.push("job.jobId is invalid");
  }
  boundedText(job.userIntent, 1, 1000, "job.userIntent", errors);
  return errors;
}

export function validateCatalog(catalog) {
  const errors = [];
  if (!plainObject(catalog)) {
    return {
      errors: ["candidate catalog must contain a JSON object"],
      groups: new Map(),
    };
  }
  exactKeys(
    catalog,
    ["compositionId", "version", "candidateSetHash", "targetComponentIds", "outer", "base"],
    "catalog",
    errors,
  );
  boundedText(catalog.compositionId, 3, 120, "catalog.compositionId", errors);
  if (!nonNegativeInteger(catalog.version)) errors.push("catalog.version must be a non-negative integer");
  if (typeof catalog.candidateSetHash !== "string" || !HASH_PATTERN.test(catalog.candidateSetHash)) {
    errors.push("catalog.candidateSetHash is invalid");
  }
  stringArray(catalog.targetComponentIds, "catalog.targetComponentIds", errors, {
    min: 1,
    maxLength: 100,
  });

  validateOuter(catalog.outer, errors);
  const groups = validateBase(catalog.base, errors);
  if (
    plainObject(catalog.outer) &&
    typeof catalog.outer.candidateId === "string" &&
    groups.candidateIds.has(catalog.outer.candidateId)
  ) {
    errors.push("aggregate Outer candidate must not appear in Base candidates");
  }
  return { errors, groups: groups.byId };
}

export function validatePlan(job, catalog, plan) {
  const catalogResult = validateCatalog(catalog);
  const errors = [...validateJob(job), ...catalogResult.errors];
  if (!plainObject(plan)) return [...errors, "replacement plan must contain a JSON object"];
  exactKeys(
    plan,
    ["schemaVersion", "jobId", "compositionId", "candidateSetHash", "decisions", "summary"],
    "plan",
    errors,
  );
  if (plan.schemaVersion !== "1.0") errors.push("plan.schemaVersion must be 1.0");
  if (plan.jobId !== job?.jobId) errors.push("plan.jobId does not match job.json");
  if (plan.compositionId !== catalog?.compositionId) {
    errors.push("plan.compositionId does not match the candidate catalog");
  }
  if (plan.candidateSetHash !== catalog?.candidateSetHash) {
    errors.push("plan.candidateSetHash does not match the candidate catalog");
  }
  boundedText(plan.summary, 1, 300, "plan.summary", errors);
  rejectPrivateEvidence(plan.summary, "plan.summary", errors);

  const groups = catalogResult.groups;
  if (!Array.isArray(plan.decisions)) {
    errors.push("plan.decisions must be an array");
    return errors;
  }
  if (plan.decisions.length > 6) errors.push("plan.decisions must contain at most 6 entries");
  const seenGroups = new Set();
  const seenCandidateIds = new Set();
  let previousGroup = null;
  for (const [index, decision] of plan.decisions.entries()) {
    const label = `plan.decisions[${index}]`;
    if (!plainObject(decision)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    exactKeys(
      decision,
      ["targetGroupId", "selectedCandidateId", "rankedCandidateIds", "confidence", "explanation"],
      label,
      errors,
    );
    if (typeof decision.targetGroupId !== "string" || !TARGET_GROUP_PATTERN.test(decision.targetGroupId)) {
      errors.push(`${label}.targetGroupId is invalid`);
    }
    if (seenGroups.has(decision.targetGroupId)) errors.push(`duplicate target group: ${decision.targetGroupId}`);
    seenGroups.add(decision.targetGroupId);
    if (previousGroup !== null && compareString(previousGroup, decision.targetGroupId) >= 0) {
      errors.push("plan.decisions must be ordered by targetGroupId");
    }
    previousGroup = decision.targetGroupId;

    const group = groups.get(decision.targetGroupId);
    if (!group) errors.push(`unknown Base target group: ${decision.targetGroupId}`);
    const ranked = stringArray(decision.rankedCandidateIds, `${label}.rankedCandidateIds`, errors, {
      min: 1,
      pattern: CANDIDATE_ID_PATTERN,
    });
    const expected = group?.candidates.map((candidate) => candidate.id) ?? [];
    if (!sameSet(ranked, expected)) {
      errors.push(`${label}.rankedCandidateIds must contain every supplied candidate for its group exactly once`);
    }
    for (const id of ranked) {
      if (!expected.includes(id)) errors.push(`${label}.rankedCandidateIds contains an unknown candidate: ${id}`);
      if (seenCandidateIds.has(id)) errors.push(`candidate is ranked in multiple groups: ${id}`);
      seenCandidateIds.add(id);
    }

    if (decision.selectedCandidateId !== null &&
      (typeof decision.selectedCandidateId !== "string" || !CANDIDATE_ID_PATTERN.test(decision.selectedCandidateId))) {
      errors.push(`${label}.selectedCandidateId must be a supplied candidate ID or null`);
    }
    if (decision.selectedCandidateId !== null) {
      if (ranked[0] !== decision.selectedCandidateId) {
        errors.push(`${label}.selectedCandidateId must be the first ranked candidate`);
      }
      const selected = group?.candidates.find((candidate) => candidate.id === decision.selectedCandidateId);
      if (!selected) errors.push(`${label}.selectedCandidateId is not supplied for this group`);
      else if (selected.coveragePixelCount !== selected.pixelCount) {
        errors.push(`${label}.selectedCandidateId does not provide complete coverage`);
      }
    }
    if (typeof decision.confidence !== "number" || !Number.isFinite(decision.confidence) || decision.confidence < 0 || decision.confidence > 1) {
      errors.push(`${label}.confidence must be between 0 and 1`);
    }
    boundedText(decision.explanation, 1, 240, `${label}.explanation`, errors);
    rejectPrivateEvidence(decision.explanation, `${label}.explanation`, errors);
  }
  for (const groupId of groups.keys()) {
    if (!seenGroups.has(groupId)) errors.push(`missing Base target group decision: ${groupId}`);
  }
  return errors;
}

export function summarizeCatalog(job, catalog) {
  const jobErrors = validateJob(job);
  const catalogResult = validateCatalog(catalog);
  const errors = [...jobErrors, ...catalogResult.errors];
  if (errors.length > 0) return { valid: false, errorCount: errors.length, errors };
  const targetGroups = [...catalogResult.groups.values()]
    .sort((left, right) => compareString(left.targetGroupId, right.targetGroupId))
    .map((group) => ({
      targetGroupId: group.targetGroupId,
      pixelCount: group.pixelCount,
      candidates: [...group.candidates]
        .sort((left, right) => compareString(left.id, right.id))
        .map((candidate) => ({
          id: candidate.id,
          kind: candidate.kind,
          label: candidate.label,
          description: candidate.description,
          coveragePixelCount: candidate.coveragePixelCount,
          pixelCount: candidate.pixelCount,
          complete: candidate.coveragePixelCount === candidate.pixelCount,
          ...(candidate.sourceRevisionId ? { sourceRevisionId: candidate.sourceRevisionId } : {}),
          ...(candidate.selectedByDefault === true ? { selectedByDefault: true } : {}),
        })),
    }));
  return {
    valid: true,
    jobId: job.jobId,
    compositionId: catalog.compositionId,
    candidateSetHash: catalog.candidateSetHash,
    restorationVersion: catalog.version,
    userIntent: job.userIntent,
    outer: {
      managedByHost: true,
      pixelCount: catalog.outer.pixelCount,
      candidatePresent: catalog.outer.candidateId !== null,
    },
    base: {
      pixelCount: catalog.base.pixelCount,
      coveredPixelCount: catalog.base.coveredPixelCount,
      missingPixelCount: catalog.base.missingPixelCount,
      targetGroups,
    },
  };
}

function validateOuter(outer, errors) {
  if (!plainObject(outer)) {
    errors.push("catalog.outer must be an object");
    return;
  }
  exactKeys(outer, ["pixelCount", "candidateId"], "catalog.outer", errors);
  if (!nonNegativeInteger(outer.pixelCount)) errors.push("catalog.outer.pixelCount must be a non-negative integer");
  if (outer.candidateId !== null && (typeof outer.candidateId !== "string" || !CANDIDATE_ID_PATTERN.test(outer.candidateId))) {
    errors.push("catalog.outer.candidateId is invalid");
  }
  if (outer.pixelCount === 0 && outer.candidateId !== null) {
    errors.push("catalog.outer.candidateId must be null when no Outer pixels exist");
  }
  if (outer.pixelCount > 0 && outer.candidateId === null) {
    errors.push("catalog.outer.candidateId is required when Outer pixels exist");
  }
}

function validateBase(base, errors) {
  const byId = new Map();
  const candidateIds = new Set();
  if (!plainObject(base)) {
    errors.push("catalog.base must be an object");
    return { byId, candidateIds };
  }
  exactKeys(base, ["pixelCount", "coveredPixelCount", "missingPixelCount", "candidates"], "catalog.base", errors);
  for (const key of ["pixelCount", "coveredPixelCount", "missingPixelCount"]) {
    if (!nonNegativeInteger(base[key])) errors.push(`catalog.base.${key} must be a non-negative integer`);
  }
  if (nonNegativeInteger(base.pixelCount) && nonNegativeInteger(base.coveredPixelCount) && base.coveredPixelCount > base.pixelCount) {
    errors.push("catalog.base.coveredPixelCount exceeds pixelCount");
  }
  if (nonNegativeInteger(base.pixelCount) && nonNegativeInteger(base.coveredPixelCount) && nonNegativeInteger(base.missingPixelCount) && base.missingPixelCount !== base.pixelCount - base.coveredPixelCount) {
    errors.push("catalog.base.missingPixelCount is inconsistent");
  }
  if (!Array.isArray(base.candidates)) {
    errors.push("catalog.base.candidates must be an array");
    return { byId, candidateIds };
  }
  for (const [index, candidate] of base.candidates.entries()) {
    const label = `catalog.base.candidates[${index}]`;
    if (!plainObject(candidate)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    exactKeys(
      candidate,
      ["id", "kind", "targetGroupId", "label", "description", "pixelCount", "coveragePixelCount"],
      label,
      errors,
      ["sourceRevisionId", "rgba", "selectedByDefault"],
    );
    if (typeof candidate.id !== "string" || !CANDIDATE_ID_PATTERN.test(candidate.id)) errors.push(`${label}.id is invalid`);
    else if (candidateIds.has(candidate.id)) errors.push(`duplicate candidate ID: ${candidate.id}`);
    else candidateIds.add(candidate.id);
    if (!BASE_KINDS.has(candidate.kind)) errors.push(`${label}.kind is invalid for Base restoration`);
    if (typeof candidate.targetGroupId !== "string" || !TARGET_GROUP_PATTERN.test(candidate.targetGroupId)) errors.push(`${label}.targetGroupId is invalid`);
    boundedText(candidate.label, 1, 120, `${label}.label`, errors);
    boundedText(candidate.description, 1, 500, `${label}.description`, errors);
    if (!positiveInteger(candidate.pixelCount)) errors.push(`${label}.pixelCount must be a positive integer`);
    if (!nonNegativeInteger(candidate.coveragePixelCount) || (positiveInteger(candidate.pixelCount) && candidate.coveragePixelCount > candidate.pixelCount)) {
      errors.push(`${label}.coveragePixelCount is invalid`);
    }
    if (candidate.sourceRevisionId !== undefined) boundedText(candidate.sourceRevisionId, 1, 120, `${label}.sourceRevisionId`, errors);
    if (candidate.selectedByDefault !== undefined && typeof candidate.selectedByDefault !== "boolean") errors.push(`${label}.selectedByDefault must be boolean`);
    if (candidate.kind === "manual_rgba") validateOpaqueRgba(candidate.rgba, `${label}.rgba`, errors);
    else if (candidate.rgba !== undefined) errors.push(`${label}.rgba is only valid for manual_rgba`);

    let group = byId.get(candidate.targetGroupId);
    if (!group) {
      group = { targetGroupId: candidate.targetGroupId, pixelCount: candidate.pixelCount, candidates: [] };
      byId.set(candidate.targetGroupId, group);
    } else if (group.pixelCount !== candidate.pixelCount) {
      errors.push(`Base candidates disagree on pixelCount for ${candidate.targetGroupId}`);
    }
    group.candidates.push(candidate);
  }
  const groupedPixelCount = [...byId.values()].reduce((total, group) => total + (positiveInteger(group.pixelCount) ? group.pixelCount : 0), 0);
  if (nonNegativeInteger(base.pixelCount) && groupedPixelCount !== base.pixelCount) {
    errors.push("catalog.base.pixelCount does not match the target-group total");
  }
  if (base.pixelCount > 0 && byId.size === 0) errors.push("catalog has Base pixels but no Base target groups");
  if (base.pixelCount === 0 && base.candidates.length > 0) errors.push("catalog has Base candidates but no Base pixels");
  return { byId, candidateIds };
}

function exactKeys(value, required, label, errors, optional = []) {
  if (!plainObject(value)) return;
  const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!(key in value)) errors.push(`${label} is missing ${key}`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`${label} contains unsupported field: ${key}`);
}

function stringArray(value, label, errors, options = {}) {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return [];
  }
  if (options.min !== undefined && value.length < options.min) errors.push(`${label} must contain at least ${options.min} item(s)`);
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || (options.maxLength && item.length > options.maxLength) || (options.pattern && !options.pattern.test(item))) {
      errors.push(`${label} contains an invalid string`);
      continue;
    }
    if (seen.has(item)) errors.push(`${label} contains duplicate value: ${item}`);
    seen.add(item);
  }
  return value.filter((item) => typeof item === "string");
}

function boundedText(value, min, max, label, errors) {
  if (typeof value !== "string" || value.trim().length < min || value.length > max) errors.push(`${label} must contain ${min}-${max} characters`);
}

function rejectPrivateEvidence(value, label, errors) {
  if (typeof value !== "string") return;
  if (FORBIDDEN_PROSE.some((pattern) => pattern.test(value))) {
    errors.push(`${label} contains private pixel, color, mask, or image evidence`);
  }
}

function validateOpaqueRgba(value, label, errors) {
  if (!Array.isArray(value) || value.length !== 4 || value.some((item) => !Number.isInteger(item) || item < 0 || item > 255) || value[3] !== 255) {
    errors.push(`${label} must contain four bytes with alpha 255`);
  }
}

function sameSet(left, right) {
  return left.length === right.length && new Set(left).size === left.length && left.every((item) => right.includes(item));
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function compareString(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
