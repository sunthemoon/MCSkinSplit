import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { currentBrowserSourceFingerprint } from "./completion-browser-source.mjs";

const TEMP_PREFIX = "mcskinsplit-e2e-";
const rawArguments = process.argv.slice(2).filter((argument) => argument !== "--");
const evidenceArgumentIndex = rawArguments.indexOf("--evidence");
if (
  evidenceArgumentIndex >= 0 &&
  (evidenceArgumentIndex === rawArguments.length - 1 ||
    rawArguments.indexOf("--evidence", evidenceArgumentIndex + 1) >= 0)
) {
  throw new Error("--evidence requires exactly one output path");
}
const evidenceOutputPath = evidenceArgumentIndex < 0
  ? null
  : resolve(rawArguments[evidenceArgumentIndex + 1]);
const realProviderMode = rawArguments.includes("--real-provider");
const realMode = realProviderMode || rawArguments.includes("--real");
const playwrightArguments = rawArguments.filter((argument, index) =>
  argument !== "--real" &&
  argument !== "--real-provider" &&
  index !== evidenceArgumentIndex &&
  index !== evidenceArgumentIndex + 1
);
if (evidenceOutputPath && (realMode || playwrightArguments.length > 0)) {
  throw new Error(
    "Browser release evidence must run the complete deterministic suite without filters",
  );
}

const tempParent = await realpath(resolve(tmpdir()));
const temporaryRoot = await mkdtemp(join(tempParent, TEMP_PREFIX));
const resolvedTemporaryRoot = await realpath(temporaryRoot);
validateTemporaryRoot(resolvedTemporaryRoot, tempParent);

const offDataDirectory = join(resolvedTemporaryRoot, "feature-off");
const onDataDirectory = join(resolvedTemporaryRoot, "feature-on");
const rawEvidencePath = join(resolvedTemporaryRoot, "playwright-report.json");
await Promise.all([
  mkdir(offDataDirectory, { recursive: false }),
  mkdir(onDataDirectory, { recursive: false }),
]);

const [offApiPort, offWebPort, onApiPort, onWebPort] = await allocatePorts(4);
const environment = {
  ...process.env,
  MC_SKIN_E2E_ROOT: resolvedTemporaryRoot,
  MC_SKIN_E2E_DATA_OFF: offDataDirectory,
  MC_SKIN_E2E_DATA_ON: onDataDirectory,
  MC_SKIN_E2E_OFF_API_PORT: String(offApiPort),
  MC_SKIN_E2E_OFF_WEB_PORT: String(offWebPort),
  MC_SKIN_E2E_ON_API_PORT: String(onApiPort),
  MC_SKIN_E2E_ON_WEB_PORT: String(onWebPort),
  MC_SKIN_E2E_REAL: realMode ? "true" : "false",
  MC_SKIN_E2E_REAL_PROVIDER: realProviderMode ? "true" : "false",
  ...(evidenceOutputPath
    ? { MC_SKIN_E2E_RESULT_PATH: rawEvidencePath }
    : {}),
};
delete environment.NO_COLOR;

let child;
let forwardedSignal;
try {
  const pnpmCli = process.env.npm_execpath;
  if (!pnpmCli || !isAbsolute(pnpmCli)) {
    throw new Error(
      "The browser-test runner must be started through a pnpm package script",
    );
  }
  child = spawn(
    process.execPath,
    [pnpmCli, "exec", "playwright", "test", ...playwrightArguments],
    {
      cwd: process.cwd(),
      env: environment,
      stdio: "inherit",
      windowsHide: true,
    },
  );

  const forward = (signal) => {
    forwardedSignal = signal;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
    }
  };
  process.once("SIGINT", forward);
  process.once("SIGTERM", forward);

  const result = await new Promise((resolveResult, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveResult({ code, signal }));
  });

  process.removeListener("SIGINT", forward);
  process.removeListener("SIGTERM", forward);
  if (result.signal || forwardedSignal) {
    process.exitCode = forwardedSignal === "SIGINT" ? 130 : 143;
  } else {
    if (evidenceOutputPath) {
      await writeBrowserReleaseEvidence({
        childExitCode: result.code ?? 1,
        outputPath: evidenceOutputPath,
        rawReportPath: rawEvidencePath,
      });
    }
    process.exitCode = result.code ?? 1;
  }
} finally {
  validateTemporaryRoot(resolvedTemporaryRoot, tempParent);
  await rm(resolvedTemporaryRoot, { force: true, recursive: true });
}

function validateTemporaryRoot(target, expectedParent) {
  if (
    !isAbsolute(target) ||
    dirname(target) !== expectedParent ||
    !basename(target).startsWith(TEMP_PREFIX)
  ) {
    throw new Error(`Refusing to remove unexpected browser-test path: ${target}`);
  }
}

async function allocatePorts(count) {
  const servers = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const server = createServer();
      servers.push(server);
      await new Promise((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolveListen);
      });
    }
    return servers.map((server) => {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to allocate a browser-test port");
      }
      return address.port;
    });
  } finally {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise((resolveClose) => server.close(() => resolveClose())),
      ),
    );
  }
}

async function writeBrowserReleaseEvidence(input) {
  const report = JSON.parse(await readFile(input.rawReportPath, "utf8"));
  const fingerprint = await currentBrowserSourceFingerprint();
  const tests = collectBrowserTests(report.suites ?? [])
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
  const require = createRequire(import.meta.url);
  const playwrightVersion = require("@playwright/test/package.json").version;
  const body = {
    schemaVersion: "1.0",
    suiteVersion: "completion-player-browser-release-v1",
    mode: "deterministic-replay",
    browserName: "chromium",
    playwrightVersion,
    sourceHash: fingerprint.sourceHash,
    sourceFileCount: fingerprint.sourceFileCount,
    startedAt: report.stats.startTime,
    durationMs: Math.round(report.stats.duration),
    status: input.childExitCode === 0 &&
        report.stats.unexpected === 0 &&
        tests.every((test) => test.status === "passed")
      ? "passed"
      : "failed",
    tests,
  };
  const evidence = { ...body, evidenceHash: hashCanonical(body) };
  await mkdir(dirname(input.outputPath), { recursive: true });
  await writeFile(input.outputPath, canonicalJson(evidence), "utf8");
  process.stdout.write(`Browser release evidence: ${input.outputPath}\n`);
}

function collectBrowserTests(suites, parentTitles = []) {
  return suites.flatMap((suite) => {
    const normalizedFile = normalizeE2eFile(suite.file);
    const fileTitle = basename(normalizedFile);
    const suiteTitle = String(suite.title ?? "").trim();
    const nextTitles = !suiteTitle ||
        suiteTitle === fileTitle ||
        normalizeRepoPath(suiteTitle) === normalizedFile
      ? parentTitles
      : [...parentTitles, suiteTitle];
    const direct = (suite.specs ?? []).flatMap((spec) =>
      (spec.tests ?? []).map((test) => {
        const results = test.results ?? [];
        const terminal = results.at(-1);
        return {
          id: `${normalizeE2eFile(spec.file)}::${[
            ...nextTitles,
            spec.title,
          ].join(" > ")}`,
          status: mapTestStatus(terminal?.status),
          durationMs: Math.round(
            results.reduce((total, result) => total + Number(result.duration ?? 0), 0),
          ),
          retries: Number(terminal?.retry ?? 0),
        };
      })
    );
    return [
      ...direct,
      ...collectBrowserTests(suite.suites ?? [], nextTitles),
    ];
  });
}

function mapTestStatus(status) {
  switch (status) {
    case "passed":
      return "passed";
    case "skipped":
      return "skipped";
    case "timedOut":
      return "timed_out";
    case "interrupted":
      return "interrupted";
    default:
      return "failed";
  }
}

function canonicalJson(value) {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

function hashCanonical(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right, "en"))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}

function normalizeRepoPath(value) {
  return String(value ?? "").replaceAll("\\", "/");
}

function normalizeE2eFile(value) {
  const normalized = normalizeRepoPath(value).replace(/^\.\//u, "");
  return normalized.startsWith("tests/e2e/")
    ? normalized
    : `tests/e2e/${normalized}`;
}
