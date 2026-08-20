import { defineConfig, devices } from "@playwright/test";

const environment = readHarnessEnvironment();
const evidenceResultPath = process.env.MC_SKIN_E2E_RESULT_PATH;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CODEX_CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: evidenceResultPath
    ? [["list"], ["json", { outputFile: evidenceResultPath }]]
    : [["list"]],
  outputDir: "test-results",
  grep: environment.realMode ? /@real/ : undefined,
  grepInvert: environment.realMode ? undefined : /@real/,
  use: {
    ...devices["Desktop Chrome"],
    baseURL: environment.onWebUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: [
    apiServer(
      environment.offApiPort,
      environment.offDataDirectory,
      environment.realProvider,
    ),
    webServer(environment.offApiPort, environment.offWebPort, false),
    apiServer(
      environment.onApiPort,
      environment.onDataDirectory,
      environment.realProvider,
    ),
    webServer(environment.onApiPort, environment.onWebPort, true),
  ],
});

function apiServer(
  port: number,
  dataDirectory: string,
  realProvider: boolean,
) {
  return {
    command: realProvider
      ? "pnpm --filter @mc-skin-split/api start"
      : "pnpm --filter @mc-skin-split/api exec tsx ../../tests/e2e/server/replay-api.ts",
    cwd: process.cwd(),
    env: {
      ...process.env,
      MC_SKIN_API_HOST: "127.0.0.1",
      MC_SKIN_API_PORT: String(port),
      MC_SKIN_DATA_DIR: dataDirectory,
      AI_COMPLETION_RANKING: "false",
      ...(realProvider ? {} : { AI_PROVIDER: "e2e-replay" }),
    },
    url: `http://127.0.0.1:${port}/api/projects`,
    reuseExistingServer: false,
    timeout: 120_000,
  } as const;
}

function webServer(apiPort: number, webPort: number, completionEnabled: boolean) {
  return {
    command:
      "pnpm --filter @mc-skin-split/web exec vite --config vite.e2e.config.ts",
    cwd: process.cwd(),
    env: {
      ...process.env,
      MC_SKIN_E2E_API_PORT: String(apiPort),
      MC_SKIN_E2E_WEB_PORT: String(webPort),
      VITE_ENABLE_COMPLETION_WORKSPACE: completionEnabled ? "true" : "false",
    },
    url: `http://127.0.0.1:${webPort}`,
    reuseExistingServer: false,
    timeout: 120_000,
  } as const;
}

function readHarnessEnvironment() {
  const root = requireAbsolutePath("MC_SKIN_E2E_ROOT");
  const offDataDirectory = requireChildPath("MC_SKIN_E2E_DATA_OFF", root);
  const onDataDirectory = requireChildPath("MC_SKIN_E2E_DATA_ON", root);
  const offApiPort = requirePort("MC_SKIN_E2E_OFF_API_PORT");
  const offWebPort = requirePort("MC_SKIN_E2E_OFF_WEB_PORT");
  const onApiPort = requirePort("MC_SKIN_E2E_ON_API_PORT");
  const onWebPort = requirePort("MC_SKIN_E2E_ON_WEB_PORT");
  return {
    offApiPort,
    offDataDirectory,
    offWebPort,
    offWebUrl: `http://127.0.0.1:${offWebPort}`,
    onApiPort,
    onApiUrl: `http://127.0.0.1:${onApiPort}`,
    onDataDirectory,
    onWebPort,
    onWebUrl: `http://127.0.0.1:${onWebPort}`,
    realMode: process.env.MC_SKIN_E2E_REAL === "true",
    realProvider: process.env.MC_SKIN_E2E_REAL_PROVIDER === "true",
  };
}

function requireAbsolutePath(name: string): string {
  const value = process.env[name];
  if (!value || !/^(?:[A-Za-z]:[\\/]|\/)/.test(value)) {
    throw new Error(`${name} must be an absolute path set by the E2E runner`);
  }
  return value;
}

function requireChildPath(name: string, root: string): string {
  const value = requireAbsolutePath(name);
  const normalizedRoot = root.replace(/[\\/]+$/, "").toLowerCase();
  const normalizedValue = value.toLowerCase();
  if (!normalizedValue.startsWith(`${normalizedRoot}\\`) &&
      !normalizedValue.startsWith(`${normalizedRoot}/`)) {
    throw new Error(`${name} must be inside MC_SKIN_E2E_ROOT`);
  }
  return value;
}

function requirePort(name: string): number {
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be an integer port between 1 and 65535`);
  }
  return value;
}

export const E2E_ENVIRONMENT = environment;
