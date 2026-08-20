import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const BROWSER_SOURCE_PATHS = [
  ".agents",
  "apps",
  "packages",
  "tests/e2e",
  "scripts",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "playwright.config.ts",
  "tsconfig.base.json",
];

export async function currentBrowserSourceFingerprint(
  repositoryRoot = process.cwd(),
) {
  const root = resolve(repositoryRoot);
  const { stdout } = await execFileAsync(
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      ...BROWSER_SOURCE_PATHS,
    ],
    { cwd: root, encoding: "buffer", maxBuffer: 32 * 1024 * 1024 },
  );
  const paths = Buffer.from(stdout)
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort(compareString);
  if (paths.length === 0) {
    throw new Error("Browser source fingerprint contains no files");
  }
  const digest = createHash("sha256");
  for (const relativePath of paths) {
    const bytes = await readFile(resolve(root, relativePath));
    digest.update(`${Buffer.byteLength(relativePath, "utf8")}\0${relativePath}\0`);
    digest.update(`${bytes.length}\0`);
    digest.update(bytes);
  }
  return {
    sourceHash: `sha256:${digest.digest("hex")}`,
    sourceFileCount: paths.length,
  };
}

function compareString(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(
    `${JSON.stringify(await currentBrowserSourceFingerprint(), null, 2)}\n`,
  );
}
