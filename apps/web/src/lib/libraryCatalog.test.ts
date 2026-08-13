import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIBRARY_FILTERS,
  buildLibraryProjectOptions,
  filterLibraryAssets,
  librarySourceLabel,
} from "./libraryCatalog";
import type { ApiPart } from "./revisionApi";

function part(overrides: Partial<ApiPart> = {}): ApiPart {
  return {
    id: "part_123456789",
    sourceProjectId: "project_aaaaaa111",
    sourceRevisionId: "revision_1",
    sourceComponentId: "hair.main",
    name: "Long brown hair",
    category: "hair",
    armType: "slim",
    manifest: {} as ApiPart["manifest"],
    libraryStatus: "active",
    retiredAt: null,
    retiredReason: null,
    sourceProjectName: "Brown skin",
    sourceBranchName: "main",
    sourceRevisionSequence: 2,
    createdAt: "2026-08-13T00:00:00.000Z",
    ...overrides,
  };
}

describe("library catalog view model", () => {
  it("defaults to active assets and searches names, source projects, and category labels", () => {
    const active = part();
    const retired = part({ id: "part_retired", name: "Old eyes", libraryStatus: "retired" });
    expect(filterLibraryAssets([active, retired], DEFAULT_LIBRARY_FILTERS)).toEqual([active]);
    expect(filterLibraryAssets([active, retired], { ...DEFAULT_LIBRARY_FILTERS, query: "棕色皮肤" })).toEqual([]);
    expect(filterLibraryAssets([active, retired], { ...DEFAULT_LIBRARY_FILTERS, query: "brown skin" })).toEqual([active]);
    expect(filterLibraryAssets([active, retired], { ...DEFAULT_LIBRARY_FILTERS, query: "头发" })).toEqual([active]);
  });

  it("filters by stable source project ID even when names collide", () => {
    const first = part();
    const second = part({ id: "part_2", sourceProjectId: "project_bbbbbb222" });
    const filters = { ...DEFAULT_LIBRARY_FILTERS, projectId: second.sourceProjectId };
    expect(filterLibraryAssets([first, second], filters)).toEqual([second]);
  });

  it("disambiguates duplicate project names in source chips", () => {
    const first = part({ sourceProjectName: "same" });
    const second = part({ sourceProjectName: "same", sourceProjectId: "project_bbbbbb222" });
    const options = buildLibraryProjectOptions([first, second]);
    expect(options.map((option) => option.label)).toEqual(["same · aaaaaa", "same · bbbbbb"]);
    expect(librarySourceLabel(second, options)).toBe("same · bbbbbb · main #2");
  });
});
