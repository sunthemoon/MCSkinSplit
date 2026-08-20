import { readFile } from "node:fs/promises";
import {
  decodeSkinPng,
  type ArmType,
  type RgbaImage,
} from "../../packages/skin-core/src/index";
import {
  expect,
  request,
  test,
  type Locator,
  type Page,
} from "@playwright/test";
import {
  connectedExactColorPixelIds,
  mirroredSelectionPixelIds,
  seamExpansionPixelIds,
  visibleUsedPixelIds,
} from "../../apps/web/src/lib/semanticSelectionTools";
import {
  ALTERNATE_SKIN_PATH,
  loadRevisionSegmentation,
  seedCompletionSource,
  seedImportedProject,
  SLIM_SKIN_PATH,
} from "./fixtures/api";
import {
  installBlobUrlTracker,
  readBlobUrlSnapshot,
} from "./fixtures/blob-url-tracker";
import {
  collectCompletionRequests,
  E2E,
  openProject,
} from "./fixtures/harness";

test.describe("M20 deterministic player browser gate", () => {
  test("keeps Completion absent and makes no Completion request when the flag is off", async ({
    browser,
  }) => {
    const api = await request.newContext({ baseURL: E2E.featureOff.apiUrl });
    const source = await seedCompletionSource(api, "E2E feature-off source");
    const context = await browser.newContext({ baseURL: E2E.featureOff.webUrl });
    const page = await context.newPage();
    const completionRequests = collectCompletionRequests(page);
    await openProject(page, source.projectId, "#player-review");

    await expect(page.getByLabel("隐藏内容补全实验工作区")).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(completionRequests).toEqual([]);

    await context.close();
    await api.dispose();
  });

  test("exposes the gated four-step workspace without horizontal overflow", async ({
    page,
  }) => {
    await page.goto("#player-review");
    await expect(page.getByLabel("隐藏内容补全实验工作区")).toBeVisible();
    await expect(page.getByLabel("隐藏内容补全四步进度")).toBeVisible();

    for (const width of [1600, 1200, 700, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.getByLabel("隐藏内容补全实验工作区")).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              document.documentElement.scrollWidth -
              document.documentElement.clientWidth,
          ),
        )
        .toBeLessThanOrEqual(1);
    }
  });

  test("supports native hash navigation and keyboard activation", async ({ page }) => {
    await page.goto("/");
    const reviewStep = page.locator('[data-step="review"]');
    await reviewStep.focus();
    await expect(reviewStep).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#player-review$/);
    await expect(page.locator("#workspace-semantic")).toBeFocused();
    await page.goto("#workspace-completion");
    await expect(page).toHaveURL(/#workspace-completion$/);
    await expect(page.getByTestId("completion-workspace")).toBeFocused();
    await page.goBack();
    await expect(page).toHaveURL(/#player-review$/);
  });

  test("runs semantic recognition through the deterministic replay provider", async ({
    page,
  }) => {
    const api = await request.newContext({ baseURL: E2E.featureOn.apiUrl });
    const source = await seedImportedProject(api, "E2E replay analysis");
    await openProject(page, source.projectId, "#player-analyze");

    const start = page.getByRole("button", { name: "智能分析皮肤" });
    await expect(start).toBeEnabled();
    await start.click();
    const progress = page.getByLabel("智能分析完成度");
    await expect(progress).toHaveAttribute("aria-valuenow", "100", {
      timeout: 30_000,
    });
    await expect(page.locator(".unknown-row")).toContainText(/\d+ px 待分类/);
    await expect(page.getByLabel("已分析皮肤目录")).toContainText(
      "E2E replay analysis",
    );

    await api.dispose();
  });

  test("supports player semantic selection, Host IDs, overlays, and one relation commit", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const api = await request.newContext({ baseURL: E2E.featureOn.apiUrl });
    try {
      const source = await seedCompletionSource(api, "E2E player semantic edit");
      const segmentation = await loadRevisionSegmentation(api, source.revisionId);
      const fixture = await loadSemanticFixture(segmentation.source.armType);
      await openProject(page, source.projectId, "#player-review");

      const componentColumn = page.getByTestId("semantic-component-column");
      const canvasColumn = page.getByTestId("semantic-canvas-column");
      const classificationColumn = page.getByTestId(
        "semantic-classification-column",
      );
      await expect(componentColumn).toBeVisible();
      await expect(canvasColumn).toBeVisible();
      await expect(classificationColumn).toBeVisible();

      await componentColumn.getByRole("button", {
        name: "隐藏 E2E 待补全衣服 的语义覆盖层",
      }).click();
      await expect(componentColumn.getByRole("button", {
        name: "显示 E2E 待补全衣服 的语义覆盖层",
      })).toHaveAttribute("aria-pressed", "false");
      await componentColumn.getByRole("button", {
        name: "显示 E2E 待补全衣服 的语义覆盖层",
      }).click();
      const solo = componentColumn.getByRole("button", {
        name: "只看 E2E 待补全衣服 的语义覆盖层",
      });
      await solo.click();
      await expect(solo).toHaveAttribute("aria-pressed", "true");
      await solo.click();
      await expect(solo).toHaveAttribute("aria-pressed", "false");

      const selectionTools = page.getByTestId("semantic-selection-tools");
      const canvas = canvasColumn.getByLabel(/^语义像素编辑器/);
      const draftCount = canvasColumn.locator(
        ".semantic-draft-toolbar strong",
      );
      await selectionTools.getByRole("button", { name: "画笔" }).click();
      await activateAtlasPixel(page, canvas, fixture.expansionPixelId);
      await expect(draftCount).toHaveText("1");

      await canvasColumn.locator("summary", {
        hasText: "更多选区与语义对照",
      }).click();
      await canvasColumn.getByRole("button", {
        name: "预览镜像扩展",
      }).click();
      const expansion = canvasColumn.locator(
        ".semantic-expansion-confirm",
      );
      await expect(expansion).toContainText(
        `橙色显示 ${fixture.mirrorPixelIds.length} 个待加入像素`,
      );
      await expansion.getByRole("button", { name: "取消预览" }).click();
      await expect(expansion).toHaveCount(0);

      await canvasColumn.getByRole("button", {
        name: "预览 UV 接缝扩展",
      }).click();
      await expect(expansion).toContainText(
        `橙色显示 ${fixture.seamPixelIds.length} 个待加入像素`,
      );
      await expansion.getByRole("button", { name: "确认加入草稿" }).click();
      const expandedCount = 1 + fixture.seamPixelIds.length;
      await expect(draftCount).toHaveText(String(expandedCount));

      await canvasColumn.getByRole("button", { name: "撤销" }).click();
      await expect(draftCount).toHaveText("1");
      await canvasColumn.getByRole("button", { name: "重做" }).click();
      await expect(draftCount).toHaveText(String(expandedCount));
      await canvasColumn.getByRole("button", { name: "清空草稿" }).click();

      await selectionTools.getByRole("button", { name: "同色魔棒" }).click();
      await activateAtlasPixel(page, canvas, fixture.expansionPixelId);
      await expect(draftCount).toHaveText(String(fixture.magicPixelIds.length));
      await canvasColumn.getByRole("button", { name: "撤销" }).click();
      await expect(draftCount).toHaveText("0");
      await canvasColumn.getByRole("button", { name: "重做" }).click();
      await expect(draftCount).toHaveText(String(fixture.magicPixelIds.length));
      await canvasColumn.getByRole("button", { name: "清空草稿" }).click();

      await selectionTools.getByRole("button", { name: "画笔" }).click();
      await canvas.focus();
      await expect(canvas).toBeFocused();
      await page.keyboard.press("Space");
      await expect(draftCount).toHaveText("1");

      await classificationColumn.getByRole("button", {
        name: "+ 新组件",
      }).click();
      await classificationColumn.getByLabel("显示名称").fill(
        "E2E 玩家新组件",
      );
      await classificationColumn.locator(".semantic-form select").selectOption(
        "upper_clothing",
      );
      const assignResponsePromise = waitForSemanticOperation(page);
      await classificationColumn.getByRole("button", {
        name: "确认像素分类",
      }).click();
      const assignResponse = await assignResponsePromise;
      expect(assignResponse.status()).toBe(201);
      const assigned = await assignResponse.json() as SemanticMutationResponse;
      expect(assigned.generatedComponentId).toMatch(/^component_[a-z0-9]+$/);
      await expect(componentColumn.locator(".component-select-button", {
        hasText: "E2E 玩家新组件",
      })).toBeVisible();

      const generatedComponentId = assigned.generatedComponentId!;
      const relationEditor = page.getByTestId("semantic-relations-editor");
      await relationEditor.locator("summary").click();
      await relationEditor.getByLabel("附着到").selectOption(
        source.occludingComponentId,
      );
      await relationEditor.getByRole("group", {
        name: "成对组件",
      }).getByRole("checkbox", {
        name: "E2E 遮挡头发",
      }).check();

      const relationRequests: string[] = [];
      page.on("request", (request) => {
        if (
          request.method() === "POST" &&
          new URL(request.url()).pathname.endsWith("/operations")
        ) {
          relationRequests.push(request.url());
        }
      });
      const relationResponsePromise = waitForSemanticOperation(page);
      await relationEditor.getByRole("button", {
        name: "确认组件关系",
      }).click();
      const relationResponse = await relationResponsePromise;
      expect(relationResponse.status()).toBe(201);
      const relationRequestBody = relationResponse.request().postDataJSON() as {
        readonly type: string;
      };
      expect(relationRequestBody.type).toBe("set_component_relations");
      expect(relationRequests).toHaveLength(1);
      const related = await relationResponse.json() as SemanticMutationResponse;
      expect(related.revision.sequence).toBe(assigned.revision.sequence + 1);

      const updated = await loadRevisionSegmentation(api, related.revision.id);
      const generated = updated.components.find(
        (component) => component.instanceId === generatedComponentId,
      );
      const peer = updated.components.find(
        (component) => component.instanceId === source.occludingComponentId,
      );
      expect(generated?.relations.attachedTo).toBe(source.occludingComponentId);
      expect(generated?.relations.pairedWith).toContain(
        source.occludingComponentId,
      );
      expect(peer?.relations.pairedWith).toContain(generatedComponentId);
    } finally {
      await api.dispose();
    }
  });

  test("generates and accepts a review-only Completion candidate", async ({ page }) => {
    const api = await request.newContext({ baseURL: E2E.featureOn.apiUrl });
    const source = await seedCompletionSource(api, "E2E Completion accept");
    await openProject(page, source.projectId, "#player-review");
    await chooseCompletionComponents(page);

    await page.getByRole("button", { name: "生成补全候选" }).click();
    const candidate = page.locator('input[name="completion-candidate"]').first();
    await expect(candidate).toBeVisible({ timeout: 20_000 });
    await page.reload();
    await page.getByTestId("player-workflow-nav").waitFor({ state: "visible" });
    await expect(candidate).toBeVisible({ timeout: 20_000 });
    await candidate.check();
    await expect(page.getByLabel("所选候选精确纹理与遮罩对照")).toBeVisible();
    await expect(
      page.getByAltText("所选候选的精确推测来源遮罩"),
    ).toBeVisible();
    await page.getByRole("button", { name: "接受所选候选" }).click();
    await expect(page).toHaveURL(/#player-save$/);
    const result = page.locator("[data-player-result-surface]");
    await expect(result).toBeVisible();
    const completed = result.getByRole("button", {
      name: /已接受完成版组件/,
    });
    await expect(completed).toBeVisible();
    await completed.click();
    await expect(completed).toHaveAttribute("aria-pressed", "true");
    await expect(result).toContainText("已接受完成版组件 · 未发布");

    await api.dispose();
  });

  test("creates a manual derived candidate, accepts it, and publishes the latent Part", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const api = await request.newContext({ baseURL: E2E.featureOn.apiUrl });
    try {
      const source = await seedCompletionSource(
        api,
        "E2E Completion manual publish",
      );
      await openProject(page, source.projectId, "#player-review");
      await chooseCompletionComponents(page);

      await page.getByRole("button", { name: "生成补全候选" }).click();
      const radios = page.locator('input[name="completion-candidate"]');
      await expect(radios.first()).toBeVisible({ timeout: 20_000 });
      const originalCandidateCount = await radios.count();
      await radios.first().check();

      const manual = page.getByTestId("completion-manual-editor");
      await manual.locator("summary").click();
      await expect(manual).toContainText(/当前候选已有 \d+ 个已记录手工像素/);
      await manual.getByLabel("手工像素颜色").evaluate(
        (element) => {
          const input = element as HTMLInputElement;
          input.value = "#ff00ff";
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        },
      );
      const manualCanvas = manual.getByLabel(/^64×64 候选微调画布/);
      await manualCanvas.focus();
      await page.keyboard.press("Space");
      const manualDraftCount = manual.locator("header > span");
      await expect(manualDraftCount).toHaveText("1 / 256");
      await expect(page.getByRole("button", {
        name: "先应用或取消微调",
      })).toBeDisabled();

      await manual.getByRole("button", { name: "撤销" }).click();
      await expect(manualDraftCount).toHaveText("0 / 256");
      await manual.getByRole("button", { name: "重做" }).click();
      await expect(manualDraftCount).toHaveText("1 / 256");

      const editResponsePromise = page.waitForResponse((response) => {
        const path = new URL(response.url()).pathname;
        return response.request().method() === "POST" &&
          /\/completion-proposals\/[^/]+\/candidates\/[^/]+\/edits$/.test(path);
      });
      await manual.getByRole("button", {
        name: /应用微调并生成(?:新)?候选/,
      }).click();
      const editResponse = await editResponsePromise;
      expect(editResponse.status()).toBe(201);
      const edited = await editResponse.json() as CompletionEditResponse;
      expect(edited.changed).toBe(true);
      expect(edited.candidateCount).toBe(originalCandidateCount + 1);
      const derived = edited.candidates.find(
        (candidate) => candidate.id === edited.editedCandidateId,
      );
      expect(derived).toMatchObject({ strategy: "manual_edit" });
      expect(derived?.baseCandidateId).toBeTruthy();
      expect(derived?.baseCandidateId).not.toBe(derived?.id);
      expect(edited.candidates.some(
        (candidate) => candidate.id === derived?.baseCandidateId,
      )).toBe(true);
      const derivedIndex = edited.candidates.findIndex(
        (candidate) => candidate.id === edited.editedCandidateId,
      );
      expect(derivedIndex).toBeGreaterThanOrEqual(0);
      await expect(radios.nth(derivedIndex)).toBeChecked();

      const acceptResponsePromise = page.waitForResponse((response) => {
        const path = new URL(response.url()).pathname;
        return response.request().method() === "POST" &&
          /\/completion-proposals\/[^/]+\/candidates\/[^/]+\/accept$/.test(path);
      });
      await page.getByRole("button", { name: "接受所选候选" }).click();
      const acceptResponse = await acceptResponsePromise;
      expect(acceptResponse.status()).toBe(201);
      const accepted = await acceptResponse.json() as CompletionAcceptResponse;
      expect(accepted.changed).toBe(true);
      expect(accepted.result?.candidateId).toBe(edited.editedCandidateId);
      expect(accepted.result?.representation).toBe("latent_component");
      await expect(page).toHaveURL(/#player-save$/);

      const result = page.locator("[data-player-result-surface]");
      const latentChoice = result.getByRole("button", {
        name: /已接受完成版组件/,
      });
      await latentChoice.click();
      await expect(latentChoice).toHaveAttribute("aria-pressed", "true");
      await expect(result.getByRole("button", {
        name: "下载所选结果 PNG",
      })).toHaveCount(0);
      await expect(result.getByRole("button", {
        name: /完整大类组合包/,
      })).toBeDisabled();

      const publishResponsePromise = page.waitForResponse((response) => {
        const path = new URL(response.url()).pathname;
        return response.request().method() === "POST" &&
          /\/completion-results\/[^/]+\/publish$/.test(path);
      });
      const publish = result.getByTestId("publish-latent-part");
      await expect(publish).toHaveText("发布完成版组件到部件库");
      await publish.click();
      const publishResponse = await publishResponsePromise;
      expect(publishResponse.status()).toBe(201);
      const published = await publishResponse.json() as CompletionPublishResponse;
      expect(published.changed).toBe(true);
      expect(published.result.publishedAt).not.toBeNull();
      expect(published.result.latentPart?.libraryStatus).toBe("active");
      await expect(publish).toHaveText("已发布到部件库");
      await expect(publish).toBeDisabled();
      await expect(result).toContainText("已接受完成版组件 · 已发布");
    } finally {
      await api.dispose();
    }
  });

  test("shows an explicit zero-candidate result and can keep the source", async ({
    page,
  }) => {
    const api = await request.newContext({ baseURL: E2E.featureOn.apiUrl });
    const source = await seedCompletionSource(api, "E2E Completion empty", {
      model: "deterministic-zero-candidates",
    });
    await openProject(page, source.projectId, "#player-review");
    await chooseCompletionComponents(page);

    await page.getByRole("button", { name: "生成补全候选" }).click();
    await expect(page.getByText("没有证据足够的候选", { exact: true }))
      .toBeVisible({ timeout: 20_000 });
    await expect(page.locator('input[name="completion-candidate"]')).toHaveCount(0);
    await page.getByRole("button", { name: "保留原结果" }).click();
    await expect(page).toHaveURL(/#player-save$/);
    const result = page.locator("[data-player-result-surface]");
    await expect(result).toBeVisible();
    await expect(result.getByRole("button", { name: /没有补全版/ }))
      .toBeVisible();

    await api.dispose();
  });

  test("rejects a Completion proposal while retaining the original result", async ({
    page,
  }) => {
    const api = await request.newContext({ baseURL: E2E.featureOn.apiUrl });
    const source = await seedCompletionSource(api, "E2E Completion reject");
    await openProject(page, source.projectId, "#player-review");
    await chooseCompletionComponents(page);

    await page.getByRole("button", { name: "生成补全候选" }).click();
    await expect(
      page.locator('input[name="completion-candidate"]').first(),
    ).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "保留原结果" }).click();
    await expect(page).toHaveURL(/#player-save$/);
    const result = page.locator("[data-player-result-surface]");
    await expect(result).toBeVisible();
    await expect(result.getByRole("button", { name: /没有补全版/ }))
      .toBeVisible();

    await api.dispose();
  });

  test("releases replaced Blob URLs across upload and Revision switching", async ({
    page,
  }) => {
    await installBlobUrlTracker(page);
    await page.goto("#workspace-preview");
    const input = page.locator('input[type="file"]');
    await input.setInputFiles(SLIM_SKIN_PATH);
    await expect(page.locator(".revision-node")).toHaveCount(1, {
      timeout: 20_000,
    });
    await input.setInputFiles(ALTERNATE_SKIN_PATH);
    await expect(page.locator(".revision-node")).toHaveCount(1, {
      timeout: 20_000,
    });
    await page.locator(".revision-node").click();

    await expect
      .poll(async () => (await readBlobUrlSnapshot(page)).revoked.length)
      .toBeGreaterThan(0);
    const snapshot = await readBlobUrlSnapshot(page);
    expect(snapshot.created.length).toBeGreaterThan(snapshot.live.length);
    expect(snapshot.unknownRevocations).toEqual([]);
  });

  test("touch input can choose evidence and start candidate generation", async ({
    browser,
  }) => {
    const api = await request.newContext({ baseURL: E2E.featureOn.apiUrl });
    const source = await seedCompletionSource(api, "E2E Completion touch");
    const context = await browser.newContext({
      baseURL: E2E.featureOn.webUrl,
      hasTouch: true,
      isMobile: true,
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    await openProject(page, source.projectId, "#player-review");

    const segmentation = await loadRevisionSegmentation(api, source.revisionId);
    const fixture = await loadSemanticFixture(segmentation.source.armType);
    const semanticCanvas = page.getByTestId("semantic-canvas-column")
      .getByLabel(/^语义像素编辑器/);
    await activateAtlasPixel(
      page,
      semanticCanvas,
      fixture.expansionPixelId,
      "touch",
    );
    await expect(semanticCanvas).toHaveAttribute(
      "aria-label",
      /已选择 1 个像素/,
    );

    const workspace = page.getByTestId("completion-workspace");
    const target = workspace.getByRole("radio", {
      name: /E2E 待补全衣服/,
    });
    const occluder = workspace.getByRole("checkbox", {
      name: /E2E 遮挡头发/,
    });
    await target.tap();
    await occluder.tap();
    await expect(target).toBeChecked();
    await expect(occluder).toBeChecked();
    await page.getByRole("button", { name: "生成补全候选" }).tap();
    await expect(
      page.locator('input[name="completion-candidate"]').first(),
    ).toBeVisible({ timeout: 20_000 });

    await context.close();
    await api.dispose();
  });
});

async function chooseCompletionComponents(page: Page): Promise<void> {
  const workspace = page.getByTestId("completion-workspace");
  const target = workspace.getByRole("radio", {
    name: /E2E 待补全衣服/,
  });
  const occluder = workspace.getByRole("checkbox", {
    name: /E2E 遮挡头发/,
  });
  await expect(target).toBeVisible({ timeout: 20_000 });
  await target.check();
  await expect(occluder).toBeVisible({ timeout: 20_000 });
  await occluder.check();
  await expect(target).toBeChecked();
  await expect(occluder).toBeChecked();
}

interface SemanticMutationResponse {
  readonly revision: {
    readonly id: string;
    readonly sequence: number;
  };
  readonly generatedComponentId?: string;
}

interface CompletionEditResponse {
  readonly changed: boolean;
  readonly editedCandidateId: string;
  readonly candidateCount: number;
  readonly candidates: readonly {
    readonly id: string;
    readonly strategy: string;
    readonly baseCandidateId?: string | null;
  }[];
}

interface CompletionAcceptResponse {
  readonly changed: boolean;
  readonly result: {
    readonly candidateId: string;
    readonly representation: string;
  } | null;
}

interface CompletionPublishResponse {
  readonly changed: boolean;
  readonly result: {
    readonly publishedAt: string | null;
    readonly latentPart: {
      readonly libraryStatus: string;
    } | null;
  };
}

interface SemanticFixture {
  readonly image: RgbaImage;
  readonly expansionPixelId: number;
  readonly magicPixelIds: readonly number[];
  readonly mirrorPixelIds: readonly number[];
  readonly seamPixelIds: readonly number[];
}

async function loadSemanticFixture(armType: ArmType): Promise<SemanticFixture> {
  const image = decodeSkinPng(await readFile(SLIM_SKIN_PATH));
  const expansionPixelId = visibleUsedPixelIds(image, armType).find(
    (pixelId) => {
      const mirrorPixelIds = mirroredSelectionPixelIds(
        image,
        armType,
        [pixelId],
      ).filter((candidate) => candidate !== pixelId);
      const seamPixelIds = seamExpansionPixelIds(image, armType, [pixelId]);
      return mirrorPixelIds.length > 0 && seamPixelIds.length > 0;
    },
  );
  if (expansionPixelId === undefined) {
    throw new Error(
      `Fixture has no visible ${armType} texel with mirror and seam evidence`,
    );
  }
  return {
    image,
    expansionPixelId,
    magicPixelIds: connectedExactColorPixelIds(
      image,
      armType,
      expansionPixelId,
    ),
    mirrorPixelIds: mirroredSelectionPixelIds(
      image,
      armType,
      [expansionPixelId],
    ).filter((candidate) => candidate !== expansionPixelId),
    seamPixelIds: seamExpansionPixelIds(
      image,
      armType,
      [expansionPixelId],
    ),
  };
}

async function activateAtlasPixel(
  page: Page,
  canvas: Locator,
  pixelId: number,
  input: "mouse" | "touch" = "mouse",
): Promise<void> {
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Semantic canvas has no visible bounding box");
  const x = box.x + ((pixelId % 64) + 0.5) * box.width / 64;
  const y = box.y + (Math.floor(pixelId / 64) + 0.5) * box.height / 64;
  if (input === "touch") await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}

function waitForSemanticOperation(page: Page) {
  return page.waitForResponse((response) => {
    const path = new URL(response.url()).pathname;
    return response.request().method() === "POST" &&
      /\/api\/revisions\/[^/]+\/operations$/.test(path);
  });
}
