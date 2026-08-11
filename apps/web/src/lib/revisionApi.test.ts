import { describe, expect, it, vi } from "vitest";
import {
  applySemanticOperation,
  commitRevisionPart,
  exportRevisionPart,
  importProjectSkin,
  loadRevisionSegmentation,
  loadRevisionSkin,
  RevisionApiError,
} from "./revisionApi";

describe("revisionApi", () => {
  it("uploads PNG bytes with encoded import metadata", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          projectId: "project_1",
          branchId: "branch_1",
          revisionId: "revision_1",
          armType: "slim",
          warnings: [],
        },
        201,
      ),
    );
    const bytes = Uint8Array.from([137, 80, 78, 71]);

    const result = await importProjectSkin(
      "project / 1",
      bytes,
      { fileName: "猫 skin.png", armType: "slim" },
      fetcher,
    );

    expect(result.revisionId).toBe("revision_1");
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(
      "/api/projects/project%20%2F%201/import?fileName=%E7%8C%AB+skin.png&armType=slim",
    );
    expect(init?.headers).toEqual({ "content-type": "image/png" });
    expect(new Uint8Array(init?.body as ArrayBuffer)).toEqual(bytes);
  });

  it("loads only image/png revision responses", async () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(bytes, { headers: { "content-type": "image/png" } }),
      );

    await expect(loadRevisionSkin("rev / 1", fetcher)).resolves.toEqual(bytes);
    expect(fetcher).toHaveBeenCalledWith("/api/revisions/rev%20%2F%201/skin.png");
  });

  it("loads the stored arm model from revision segmentation", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          segmentation: {
            schemaVersion: "1.0",
            revisionId: "rev_wide",
            source: {
              width: 64,
              height: 64,
              armType: "wide",
              coordinateOrigin: "top-left",
              sourceHash: `sha256:${"a".repeat(64)}`,
            },
          },
        },
        200,
      ),
    );

    await expect(loadRevisionSegmentation("rev_wide", fetcher)).resolves.toMatchObject(
      { source: { armType: "wide" } },
    );
  });

  it("preserves structured API errors", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        { error: { code: "SNAPSHOT_CORRUPT", message: "snapshot failed" } },
        409,
      ),
    );

    const error = await loadRevisionSkin("rev_1", fetcher).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(RevisionApiError);
    expect(error).toMatchObject({
      status: 409,
      code: "SNAPSHOT_CORRUPT",
      message: "snapshot failed",
    });
  });

  it("serializes semantic operations and encoded component routes", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ revision: { id: "rev_2" } }, 201))
      .mockResolvedValueOnce(
        jsonResponse({ part: { id: "part_1", name: "Hair" } }, 201),
      );

    await applySemanticOperation(
      "rev / 1",
      {
        type: "assign_pixels",
        target: {
          instanceId: "hair.main",
          displayName: "Hair",
          category: "hair",
        },
        spans: [{ surface: "head.base.front", y: 8, x0: 8, x1: 9 }],
      },
      { summary: "Assign hair" },
      fetcher,
    );
    await exportRevisionPart("rev / 2", "hair/main", undefined, fetcher);

    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "/api/revisions/rev%20%2F%201/operations",
    );
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      type: "assign_pixels",
      summary: "Assign hair",
      target: { instanceId: "hair.main" },
    });
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      "/api/revisions/rev%20%2F%202/components/hair%2Fmain/export-part",
    );
  });

  it("commits a part only with an explicit strategy", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          committed: true,
          revision: { id: "rev_2" },
          part: { id: "part_1" },
          report: { hardConflictCount: 2 },
        },
        201,
      ),
    );

    await commitRevisionPart("rev_1", "part_1", "use_part", fetcher);

    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      partId: "part_1",
      strategy: "use_part",
    });
  });
});

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
