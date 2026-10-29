// Writes the server's tools/list result as a tool description file for Microsoft 365 app packages
// (agentConnectors[].toolSource.remoteMcpServer.mcpToolDescription), which manifest version 1.28 requires.
// Runs the app in-process, so no server or Azure access is needed.
// Usage: npm run tool-description -- [--out toolDescription.json]
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { DevTokenIssuer } from "../src/auth/dev.js";

const { values } = parseArgs({ options: { out: { type: "string", default: "toolDescription.json" } } });

const devIssuer = await DevTokenIssuer.create();
const app = createApp({ config: loadConfig({ AUTH_MODE: "dev" }), verifier: devIssuer, devIssuer, log: () => {} });

const res = await app.request("http://localhost/mcp", {
  method: "POST",
  headers: {
    authorization: `Bearer ${await devIssuer.mint()}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
});
const { result } = await res.json();

const tools = result.tools.map(({ name, description, inputSchema }: Record<string, unknown>) => ({
  name,
  description,
  inputSchema,
}));
await writeFile(values.out, JSON.stringify({ tools }, null, 2) + "\n");
console.log(`Wrote ${tools.length} tools to ${values.out}`);
