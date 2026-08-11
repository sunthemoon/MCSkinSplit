import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApi } from "./app";

const port = readPort(process.env.MC_SKIN_API_PORT);
const host = process.env.MC_SKIN_API_HOST?.trim() || "127.0.0.1";
const dataDirectory = resolve(
  process.env.MC_SKIN_DATA_DIR?.trim() ||
    fileURLToPath(new URL("../../../data", import.meta.url)),
);
const app = buildApi({ dataDirectory, logger: true });

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}

function readPort(value: string | undefined): number {
  if (value === undefined) {
    return 3001;
  }
  const portNumber = Number(value);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535) {
    throw new Error(`MC_SKIN_API_PORT 无效：${value}`);
  }
  return portNumber;
}
