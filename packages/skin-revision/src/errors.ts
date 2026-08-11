export type RevisionStoreErrorCode =
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "CONFLICT"
  | "SNAPSHOT_CORRUPT"
  | "STORAGE_FAILURE";

export class RevisionStoreError extends Error {
  readonly code: RevisionStoreErrorCode;
  readonly statusCode: number;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: RevisionStoreErrorCode,
    message: string,
    statusCode: number,
    details?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RevisionStoreError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function notFound(entity: string, id: string): RevisionStoreError {
  return new RevisionStoreError("NOT_FOUND", `${entity} 不存在：${id}`, 404, {
    entity,
    id,
  });
}

export function invalidInput(
  message: string,
  details?: Readonly<Record<string, unknown>>,
): RevisionStoreError {
  return new RevisionStoreError("INVALID_INPUT", message, 400, details);
}

export function conflict(
  message: string,
  details?: Readonly<Record<string, unknown>>,
): RevisionStoreError {
  return new RevisionStoreError("CONFLICT", message, 409, details);
}

export function snapshotCorrupt(
  revisionId: string,
  message: string,
  options?: ErrorOptions,
): RevisionStoreError {
  return new RevisionStoreError(
    "SNAPSHOT_CORRUPT",
    `Revision ${revisionId} 快照损坏：${message}`,
    409,
    { revisionId },
    options,
  );
}
