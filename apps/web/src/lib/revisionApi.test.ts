import { describe, expect, it, vi } from "vitest";
import {
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
});

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
