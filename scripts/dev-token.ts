// Fetches a dev token from a server running with AUTH_MODE=dev.
// Usage: npm run token -- [--name "Ada Lovelace"] [--username ada@contoso.dev] [--url http://localhost:3000]
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: process.env.MCP_BASE_URL ?? "http://localhost:3000" },
    name: { type: "string" },
    username: { type: "string" },
    oid: { type: "string" },
  },
});

const res = await fetch(`${values.url}/dev/token`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: values.name, username: values.username, oid: values.oid }),
});
if (!res.ok) {
  console.error(`Failed (${res.status}). Is the server running with AUTH_MODE=dev?`);
  process.exit(1);
}
console.log((await res.json()).access_token);
