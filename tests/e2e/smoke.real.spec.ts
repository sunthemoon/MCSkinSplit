import { expect, request, test } from "@playwright/test";
import { seedImportedProject } from "./fixtures/api";
import { E2E, openProject } from "./fixtures/harness";

test("loads the real WebGL avatar adapter @real", async ({ page }) => {
  await page.goto("#workspace-preview");
  const viewer = page.getByLabel("Minecraft 皮肤三维预览");
  await expect(viewer).toBeVisible();
  await expect(viewer.locator("xpath=..")).toHaveAttribute("data-state", "ready", {
    timeout: 30_000,
  });
});

test("can run the configured real semantic provider @real @real-provider", async ({
  page,
}) => {
  test.skip(
    process.env.MC_SKIN_E2E_REAL_PROVIDER !== "true",
    "Set by the explicit real-provider runner only",
  );
  test.setTimeout(12 * 60_000);
  const api = await request.newContext({ baseURL: E2E.featureOn.apiUrl });
  const source = await seedImportedProject(api, "E2E real provider smoke");
  await openProject(page, source.projectId, "#player-analyze");
  await page.getByRole("button", { name: "智能分析皮肤" }).click();
  await expect(page.getByLabel("智能分析完成度")).toHaveAttribute(
    "aria-valuenow",
    "100",
    { timeout: 11 * 60_000 },
  );
  await api.dispose();
});
