// End-to-end check against a running server using the official MCP client.
// Usage: npm run smoke -- [--url http://localhost:3000] [--token <bearer>]
// Without --token, a dev token is fetched (server must run with AUTH_MODE=dev).
// Against Azure: --token "$(az account get-access-token --scope api://<client-id>/access_as_user --query accessToken -o tsv)"
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: process.env.MCP_BASE_URL ?? "http://localhost:3000" },
    token: { type: "string" },
  },
});

const token =
  values.token ??
  (await (await fetch(`${values.url}/dev/token`, { method: "POST", body: "{}" })).json()).access_token;

const client = new Client({ name: "smoke-test", version: "1.0.0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(`${values.url}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }),
);

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));
const whoami = await client.callTool({ name: "whoami", arguments: {} });
console.log("whoami:", JSON.stringify(whoami.structuredContent, null, 2));
await client.close();
