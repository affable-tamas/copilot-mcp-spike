import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod";
import type { UserIdentity } from "./auth/identity.js";

export interface RequestContext {
  user: UserIdentity;
  userAgent?: string;
}

/** Converts a verified identity into the SDK's AuthInfo, which tools receive as `extra.authInfo`. */
export function toAuthInfo(token: string, ctx: RequestContext): AuthInfo {
  return {
    token,
    clientId: ctx.user.clientAppId ?? "unknown",
    scopes: ctx.user.scopes,
    expiresAt: ctx.user.expiresAt,
    extra: { ...ctx },
  };
}

function requestContext(authInfo: AuthInfo | undefined): RequestContext {
  const ctx = authInfo?.extra as RequestContext | undefined;
  // The HTTP layer rejects unauthenticated requests, so this only fires on a wiring bug.
  if (!ctx?.user) throw new Error("No authenticated user on this request");
  return ctx;
}

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>,
});

export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "copilot-mcp-spike", version: "0.1.0" },
    { instructions: "Example MCP server that knows which Microsoft 365 user is calling it." },
  );

  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description:
        "Returns the identity of the signed-in Microsoft 365 user calling this server, and the client application they are calling through.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      outputSchema: {
        oid: z.string(),
        tenantId: z.string(),
        name: z.string().optional(),
        username: z.string().optional(),
        clientAppId: z.string().optional(),
        scopes: z.array(z.string()),
        userAgent: z.string().optional(),
        tokenSource: z.enum(["entra", "dev"]),
      },
    },
    async (extra) => {
      const { user, userAgent } = requestContext(extra.authInfo);
      return json({
        oid: user.oid,
        tenantId: user.tid,
        name: user.name,
        username: user.username,
        clientAppId: user.clientAppId,
        scopes: user.scopes,
        userAgent,
        tokenSource: user.source,
      });
    },
  );

  server.registerTool(
    "greet",
    {
      title: "Greet me",
      description: "Returns a personalised greeting for the signed-in user. Demonstrates using caller identity inside a tool.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        language: z.enum(["en", "hu", "de", "fr"]).default("en").describe("Language of the greeting"),
      },
    },
    async ({ language }, extra) => {
      const { user } = requestContext(extra.authInfo);
      const hello = { en: "Hello", hu: "Szia", de: "Hallo", fr: "Bonjour" }[language];
      const who = user.name ?? user.username ?? "there";
      return { content: [{ type: "text", text: `${hello}, ${who}!` }] };
    },
  );

  return server;
}
