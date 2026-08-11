import type { ArmType } from "@mc-skin-split/skin-core";

export interface ApiProject {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly defaultBranchId: string;
  readonly headRevisionId: string | null;
  readonly settings: Readonly<Record<string, unknown>>;
}

export interface ApiBranch {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly baseRevisionId: string | null;
  readonly headRevisionId: string | null;
  readonly createdAt: string;
}

export interface ApiRevision {
  readonly id: string;
  readonly projectId: string;
  readonly parentRevisionId: string | null;
  readonly branchId: string;
  readonly branchName: string;
  readonly sequence: number;
  readonly operationType: string;
  readonly actorType: "user" | "ai" | "system";
  readonly createdAt: string;
  readonly summary: string;
  readonly resultHash: string;
  readonly isBranchHead: boolean;
}

export interface ApiMutationResult {
  readonly project: ApiProject;
  readonly branch: ApiBranch;
  readonly revision: ApiRevision;
}

export interface ApiImportResult {
  readonly projectId: string;
  readonly branchId: string;
  readonly revisionId: string;
  readonly armType: ArmType;
  readonly warnings: readonly string[];
}

export interface ApiSegmentation {
  readonly schemaVersion: "1.0";
  readonly revisionId: string;
  readonly source: {
    readonly width: 64;
    readonly height: 64;
    readonly armType: ArmType;
    readonly coordinateOrigin: "top-left";
    readonly sourceHash: string;
  };
}

export class RevisionApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "RevisionApiError";
    this.status = status;
    this.code = code;
  }
}

type Fetcher = typeof fetch;

export async function listProjects(
  fetcher: Fetcher = fetch,
): Promise<readonly ApiProject[]> {
  const body = await requestJson<{ projects: readonly ApiProject[] }>(
    "/api/projects",
    undefined,
    fetcher,
  );
  return body.projects;
}

export async function createProject(
  name: string,
  fetcher: Fetcher = fetch,
): Promise<{ readonly project: ApiProject; readonly branch: ApiBranch }> {
  return requestJson(
    "/api/projects",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    },
    fetcher,
  );
}

export async function getProject(
  projectId: string,
  fetcher: Fetcher = fetch,
): Promise<ApiProject> {
  const body = await requestJson<{ project: ApiProject }>(
    `/api/projects/${encodeURIComponent(projectId)}`,
    undefined,
    fetcher,
  );
  return body.project;
}

export async function importProjectSkin(
  projectId: string,
  skinPng: Uint8Array,
  options: { readonly fileName?: string; readonly armType?: ArmType } = {},
  fetcher: Fetcher = fetch,
): Promise<ApiImportResult> {
  const query = new URLSearchParams();
  if (options.fileName) {
    query.set("fileName", options.fileName);
  }
  if (options.armType) {
    query.set("armType", options.armType);
  }
  const queryString = query.size > 0 ? `?${query.toString()}` : "";
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/import${queryString}`,
    {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: copyArrayBuffer(skinPng),
    },
    fetcher,
  );
}

export async function listBranches(
  projectId: string,
  fetcher: Fetcher = fetch,
): Promise<readonly ApiBranch[]> {
  const body = await requestJson<{ branches: readonly ApiBranch[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/branches`,
    undefined,
    fetcher,
  );
  return body.branches;
}

export async function listRevisions(
  projectId: string,
  fetcher: Fetcher = fetch,
): Promise<readonly ApiRevision[]> {
  const body = await requestJson<{ revisions: readonly ApiRevision[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/revisions`,
    undefined,
    fetcher,
  );
  return body.revisions;
}

export async function loadRevisionSkin(
  revisionId: string,
  fetcher: Fetcher = fetch,
): Promise<Uint8Array> {
  const response = await fetcher(
    `/api/revisions/${encodeURIComponent(revisionId)}/skin.png`,
  );
  await assertResponse(response);
  if (!response.headers.get("content-type")?.includes("image/png")) {
    throw new RevisionApiError(
      response.status,
      "INVALID_RESPONSE",
      "Revision API 未返回 PNG",
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

export async function loadRevisionSegmentation(
  revisionId: string,
  fetcher: Fetcher = fetch,
): Promise<ApiSegmentation> {
  const body = await requestJson<{ segmentation: ApiSegmentation }>(
    `/api/revisions/${encodeURIComponent(revisionId)}/segmentation`,
    undefined,
    fetcher,
  );
  return body.segmentation;
}

export async function revertRevision(
  revisionId: string,
  branchId: string,
  fetcher: Fetcher = fetch,
): Promise<ApiMutationResult> {
  return requestJson(
    `/api/revisions/${encodeURIComponent(revisionId)}/revert`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ branchId }),
    },
    fetcher,
  );
}

export async function branchRevision(
  revisionId: string,
  name: string,
  fetcher: Fetcher = fetch,
): Promise<ApiMutationResult> {
  return requestJson(
    `/api/revisions/${encodeURIComponent(revisionId)}/branch`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    },
    fetcher,
  );
}

async function requestJson<T>(
  url: string,
  init: RequestInit | undefined,
  fetcher: Fetcher,
): Promise<T> {
  const response = await fetcher(url, init);
  await assertResponse(response);
  return (await response.json()) as T;
}

async function assertResponse(response: Response): Promise<void> {
  if (response.ok) {
    return;
  }

  let code = `HTTP_${response.status}`;
  let message = `Revision API 请求失败：HTTP ${response.status}`;
  try {
    const body = (await response.json()) as {
      readonly error?: { readonly code?: unknown; readonly message?: unknown };
    };
    if (typeof body.error?.code === "string") {
      code = body.error.code;
    }
    if (typeof body.error?.message === "string") {
      message = body.error.message;
    }
  } catch {
    // Keep the stable HTTP fallback when the server did not return JSON.
  }
  throw new RevisionApiError(response.status, code, message);
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
