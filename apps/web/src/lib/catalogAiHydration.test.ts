import { describe, expect, it } from "vitest";
import { shouldDeferGenericAiHydration } from "./catalogAiHydration";

describe("catalog AI detail hydration", () => {
  const pending = {
    activationRequestId: 4,
    aiDetailRequestId: 9,
    revisionId: "rev_catalog_result",
  } as const;

  it("defers the generic lookup for the catalog revision being hydrated", () => {
    expect(shouldDeferGenericAiHydration("rev_catalog_result", pending)).toBe(true);
  });

  it("does not suppress hydration for another revision or without a catalog request", () => {
    expect(shouldDeferGenericAiHydration("rev_other", pending)).toBe(false);
    expect(shouldDeferGenericAiHydration("rev_catalog_result", null)).toBe(false);
  });
});
