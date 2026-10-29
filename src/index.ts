import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
import { EntraTokenVerifier } from "./auth/entra.js";
import { DevTokenIssuer } from "./auth/dev.js";

const config = loadConfig();
const devIssuer = config.authMode === "dev" ? await DevTokenIssuer.create() : undefined;
const verifier = devIssuer ?? new EntraTokenVerifier(config.entra);

const app = createApp({ config, verifier, devIssuer });

serve({ fetch: app.fetch, port: config.port }, ({ port }) => {
  console.log(`copilot-mcp-spike listening on :${port} (AUTH_MODE=${config.authMode})`);
  if (devIssuer) {
    console.log(`Dev mode: get a token with  npm run token  (or POST http://localhost:${port}/dev/token)`);
  }
});
