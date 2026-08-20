import type { Page } from "@playwright/test";

export const E2E = Object.freeze({
  featureOff: readPair("OFF"),
  featureOn: readPair("ON"),
});

export async function openProject(
  page: Page,
  projectId: string,
  path = "/",
): Promise<void> {
  await page.addInitScript(
    ([key, value]) => window.localStorage.setItem(key, value),
    ["mc-skin-split.active-project", projectId] as const,
  );
  await page.goto(path);
  await page.getByTestId("player-workflow-nav").waitFor({ state: "visible" });
  await page.waitForFunction(
    (expectedProjectId) =>
      document.querySelector<HTMLSelectElement>(
        '#workspace-history select',
      )?.value === expectedProjectId,
    projectId,
  );
}

export function collectCompletionRequests(page: Page): string[] {
  const requests: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.includes("completion-proposals")) requests.push(path);
  });
  return requests;
}

function readPair(name: "OFF" | "ON") {
  const apiPort = readPort(`MC_SKIN_E2E_${name}_API_PORT`);
  const webPort = readPort(`MC_SKIN_E2E_${name}_WEB_PORT`);
  return {
    apiUrl: `http://127.0.0.1:${apiPort}`,
    webUrl: `http://127.0.0.1:${webPort}`,
  } as const;
}

function readPort(name: string): number {
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} is not configured by the browser-test runner`);
  }
  return value;
}
