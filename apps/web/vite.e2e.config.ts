import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const webPort = readPort("MC_SKIN_E2E_WEB_PORT");
const apiPort = readPort("MC_SKIN_E2E_API_PORT");

export default defineConfig({
  plugins: [react()],
  publicDir: fileURLToPath(new URL("../../tests/fixtures", import.meta.url)),
  server: {
    host: "127.0.0.1",
    port: webPort,
    strictPort: true,
    proxy: {
      "/api": `http://127.0.0.1:${apiPort}`,
    },
  },
});

function readPort(name: string): number {
  const raw = process.env[name];
  const port = Number(raw);
  if (!raw || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer port between 1 and 65535`);
  }
  return port;
}
