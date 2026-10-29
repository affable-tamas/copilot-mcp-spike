import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { DevTokenIssuer } from "../src/auth/dev.js";

export async function devApp() {
  const devIssuer = await DevTokenIssuer.create();
  const config = loadConfig({ AUTH_MODE: "dev" });
  const app = createApp({ config, verifier: devIssuer, devIssuer, log: () => {} });
  return { app, devIssuer };
}

export function rpc(method: string, params: Record<string, unknown> = {}, id = 1) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

export const mcpHeaders = (token?: string) => ({
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});
