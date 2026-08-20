import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";

const TEMP_PREFIX = "mcskinsplit-e2e-";
const realProviderMode = process.argv.slice(2).includes("--real-provider");
const realMode = realProviderMode || process.argv.slice(2).includes("--real");
const playwrightArguments = process.argv
  .slice(2)
  .filter(
    (argument) => argument !== "--real" && argument !== "--real-provider",
  );

const tempParent = await realpath(resolve(tmpdir()));
const temporaryRoot = await mkdtemp(join(tempParent, TEMP_PREFIX));
const resolvedTemporaryRoot = await realpath(temporaryRoot);
validateTemporaryRoot(resolvedTemporaryRoot, tempParent);

const offDataDirectory = join(resolvedTemporaryRoot, "feature-off");
const onDataDirectory = join(resolvedTemporaryRoot, "feature-on");
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
