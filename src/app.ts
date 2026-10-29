import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Config } from "./config.js";
import { AuthError, type TokenVerifier, type UserIdentity } from "./auth/identity.js";
import { DevTokenIssuer } from "./auth/dev.js";
import { createMcpServer, toAuthInfo } from "./mcp.js";

type Env = { Variables: { user: UserIdentity; token: string } };

export interface AppDeps {
  config: Config;
  verifier: TokenVerifier;
  /** Present only when AUTH_MODE=dev; enables the /dev/token endpoint. */
  devIssuer?: DevTokenIssuer;
  log?: (entry: Record<string, unknown>) => void;
}

const PRM_PATH = "/.well-known/oauth-protected-resource";

export function createApp({ config, verifier, devIssuer, log = defaultLog }: AppDeps) {
  const app = new Hono<Env>();

  const baseUrl = (c: Context) => {
    if (config.publicBaseUrl) return config.publicBaseUrl;
    const url = new URL(c.req.url);
    const proto = c.req.header("x-forwarded-proto")?.split(",")[0] ?? url.protocol.replace(":", "");
    const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? url.host;
    return `${proto}://${host}`;
  };

  // Browser-based clients (e.g. MCP Inspector in direct mode) need to read these headers.
  app.use(
    "*",
    cors({
      origin: "*",
      allowHeaders: ["Authorization", "Content-Type", "Mcp-Session-Id", "Mcp-Protocol-Version", "Last-Event-ID"],
      exposeHeaders: ["WWW-Authenticate", "Mcp-Session-Id"],
    }),
  );

  app.get("/", (c) => c.text("copilot-mcp-spike: MCP endpoint is POST /mcp\n"));
  app.get("/healthz", (c) => c.json({ status: "ok" }));

  // RFC 9728 protected resource metadata. MCP clients discover the authorization server from here.
  const protectedResourceMetadata = (c: Context) => {
    const base = baseUrl(c);
    const { tenantId, audiences, requiredScope } = config.entra;
    const appIdUri = audiences.find((a) => a.includes("://")) ?? audiences[0];
    return c.json({
      resource: config.resourceId ?? `${base}/mcp`,
      authorization_servers:
        config.authMode === "entra" ? [`https://login.microsoftonline.com/${tenantId}/v2.0`] : [base],
      scopes_supported: config.authMode === "entra" ? [`${appIdUri}/${requiredScope}`] : [requiredScope],
      bearer_methods_supported: ["header"],
      resource_name: "copilot-mcp-spike",
    });
  };
  app.get(PRM_PATH, protectedResourceMetadata);
  app.get(`${PRM_PATH}/mcp`, protectedResourceMetadata);

  if (devIssuer) {
    // Local-only token endpoint. Never registered when AUTH_MODE=entra.
    app.post("/dev/token", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const access_token = await devIssuer.mint(body);
      return c.json({ access_token, token_type: "Bearer", expires_in: 8 * 3600 });
    });
  }

  const unauthorized = (c: Context, err?: AuthError) => {
    const params = [`realm="mcp"`, `resource_metadata="${baseUrl(c)}${PRM_PATH}"`];
    if (err) params.push(`error="${err.code}"`, `error_description="${err.message.replace(/"/g, "'")}"`);
    c.header("WWW-Authenticate", `Bearer ${params.join(", ")}`);
    return c.json(
      { jsonrpc: "2.0", error: { code: -32001, message: err?.message ?? "Authentication required" }, id: null },
      err?.code === "insufficient_scope" ? 403 : 401,
    );
  };

  app.use("/mcp", async (c, next) => {
    if (c.req.method === "OPTIONS") return next();
    const match = c.req.header("authorization")?.match(/^Bearer\s+(.+)$/i);
    if (!match) return unauthorized(c);
    try {
      c.set("user", await verifier.verify(match[1]));
      c.set("token", match[1]);
    } catch (err) {
      if (err instanceof AuthError) {
        log({ event: "auth_failed", reason: err.message, userAgent: c.req.header("user-agent") });
        return unauthorized(c, err);
      }
      throw err;
    }
    await next();
  });

  // Stateless Streamable HTTP: a fresh server + transport per request, so any App Service
  // instance can serve any request and no session affinity (ARR cookie) is needed.
  app.post("/mcp", async (c) => {
    const user = c.get("user");
    const userAgent = c.req.header("user-agent");
    const body = await c.req.json().catch(() => undefined);
    if (body === undefined) {
      return c.json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }, 400);
    }

    for (const msg of Array.isArray(body) ? body : [body]) {
      log({
        event: "mcp_request",
        method: msg?.method,
        tool: msg?.method === "tools/call" ? msg.params?.name : undefined,
        client: msg?.method === "initialize" ? msg.params?.clientInfo : undefined,
        oid: user.oid,
        tid: user.tid,
        username: user.username,
        clientAppId: user.clientAppId,
        userAgent,
      });
    }

    const server = createMcpServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw, {
        parsedBody: body,
        authInfo: toAuthInfo(c.get("token"), { user, userAgent }),
      });
    } finally {
      // With enableJsonResponse the response is complete once handleRequest resolves.
      await server.close();
    }
  });

  // No server-initiated streams or sessions in stateless mode.
  const methodNotAllowed = (c: Context) =>
    c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }, 405, {
      Allow: "POST",
    });
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  app.onError((err, c) => {
    log({ event: "error", message: err.message, stack: err.stack });
    return c.json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }, 500);
  });

  return app;
}

function defaultLog(entry: Record<string, unknown>) {
  // One JSON line per event; App Service forwards stdout to Log Stream / Application Insights.
  console.log(JSON.stringify({ time: new Date().toISOString(), ...entry }));
}
