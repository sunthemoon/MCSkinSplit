import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { APIRequestContext, APIResponse } from "@playwright/test";
import type {
  ArmType,
  SemanticComponent,
} from "../../../packages/skin-core/src/index";

export const SLIM_SKIN_PATH = fileURLToPath(
  new URL("../../fixtures/skins/ab87de696cfca859.png", import.meta.url),
);
export const ALTERNATE_SKIN_PATH = fileURLToPath(
  new URL("../../fixtures/skins/354359a2c2f33777.png", import.meta.url),
);

export interface SeededProject {
  readonly projectId: string;
  readonly revisionId: string;
}

export interface SeededCompletionSource extends SeededProject {
  readonly targetComponentId: string;
  readonly occludingComponentId: string;
}

export interface E2eSegmentation {
  readonly revisionId: string;
  readonly source: {
    readonly armType: ArmType;
  };
  readonly components: readonly SemanticComponent[];
}

export async function seedImportedProject(
  api: APIRequestContext,
  name: string,
): Promise<SeededProject> {
  const created = await expectJson<{
    project: { id: string };
  }>(await api.post("/api/projects", { data: { name } }), 201);
  const bytes = await readFile(SLIM_SKIN_PATH);
  const imported = await expectJson<{ revisionId: string }>(
    await api.post(
      `/api/projects/${encodeURIComponent(created.project.id)}/import?fileName=e2e-source.png`,
      {
        data: bytes,
        headers: { "content-type": "image/png" },
      },
    ),
    201,
  );
  return {
    projectId: created.project.id,
    revisionId: imported.revisionId,
  };
}

export async function seedCompletionSource(
  api: APIRequestContext,
  name: string,
  options: {
    readonly model?: "deterministic-replay" | "deterministic-zero-candidates";
  } = {},
): Promise<SeededCompletionSource> {
  const imported = await seedImportedProject(api, name);
  const targetComponentId = "clothing.e2e_completion";
  const occludingComponentId = "hair.e2e_occluder";
  const started = await expectJson<{ job: { id: string } }>(
    await api.post(`/api/revisions/${imported.revisionId}/ai-analysis`, {
      data: {
        mode: "full",
        provider: "e2e-replay",
        model: options.model ?? "deterministic-replay",
        reasoningEffort: "low",
        taxonomyLevel: "coarse",
        focus: ["hair", "upper_clothing"],
        createRevisionOnSuccess: true,
        semanticBaseline: "empty",
      },
    }),
    202,
  );
  const completed = await waitForJob(api, started.job.id);
  if (
    completed.job.status !== "succeeded" ||
    !completed.job.resultRevisionId
  ) {
    throw new Error(
      `Replay analysis did not create a result Revision: ${JSON.stringify(completed.job)}`,
    );
  }
  return {
    projectId: imported.projectId,
    revisionId: completed.job.resultRevisionId,
    targetComponentId,
    occludingComponentId,
  };
}

export async function waitForJob(
  api: APIRequestContext,
  jobId: string,
): Promise<{
  readonly job: {
    readonly status: string;
    readonly resultRevisionId: string | null;
  };
}> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const detail = await expectJson<{
      job: {
        status: string;
        resultRevisionId: string | null;
      };
    }>(await api.get(`/api/ai-jobs/${encodeURIComponent(jobId)}`), 200);
    if (["succeeded", "failed", "cancelled"].includes(detail.job.status)) {
      return detail;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`E2E Job did not reach a terminal state: ${jobId}`);
}

export async function loadRevisionSegmentation(
  api: APIRequestContext,
  revisionId: string,
): Promise<E2eSegmentation> {
  const body = await expectJson<{ segmentation: E2eSegmentation }>(
    await api.get(
      `/api/revisions/${encodeURIComponent(revisionId)}/segmentation`,
    ),
    200,
  );
  return body.segmentation;
}

async function expectJson<T>(
  response: APIResponse,
  expectedStatus: number,
): Promise<T> {
  if (response.status() !== expectedStatus) {
    throw new Error(
      `Unexpected API status ${response.status()} (expected ${expectedStatus}): ${await response.text()}`,
    );
  }
  return response.json() as Promise<T>;
}
