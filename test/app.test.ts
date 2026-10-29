import { describe, expect, it } from "vitest";
import { devApp, mcpHeaders, rpc } from "./helpers.js";

describe("MCP endpoint", () => {
  it("rejects requests without a token and points to protected resource metadata", async () => {
    const { app } = await devApp();
    const res = await app.request("http://localhost/mcp", { method: "POST", headers: mcpHeaders(), body: rpc("tools/list") });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      'Bearer realm="mcp", resource_metadata="http://localhost/.well-known/oauth-protected-resource"',
    );
  });

  it("rejects an invalid token", async () => {
    const { app } = await devApp();
    const res = await app.request("http://localhost/mcp", { method: "POST", headers: mcpHeaders("nope"), body: rpc("tools/list") });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("serves protected resource metadata, honouring forwarded headers", async () => {
    const { app } = await devApp();
    const res = await app.request("http://internal/.well-known/oauth-protected-resource", {
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "spike.azurewebsites.net" },
    });
    expect(await res.json()).toMatchObject({ resource: "https://spike.azurewebsites.net/mcp" });
  });

  it("initializes, lists tools and returns the caller's identity", async () => {
    const { app, devIssuer } = await devApp();
    const token = await devIssuer.mint({ name: "Tamas Test", username: "tamas@example.com" });
    const post = (body: string) =>
      app.request("http://localhost/mcp", { method: "POST", headers: mcpHeaders(token), body });

    const init = await post(
      rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } }),
    );
    expect(init.status).toBe(200);
    expect((await init.json()).result.serverInfo.name).toBe("copilot-mcp-spike");

    const list = await (await post(rpc("tools/list", {}, 2))).json();
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(["whoami", "greet"]);

    const whoami = await (await post(rpc("tools/call", { name: "whoami", arguments: {} }, 3))).json();
    expect(whoami.result.structuredContent).toMatchObject({
      name: "Tamas Test",
      username: "tamas@example.com",
      tokenSource: "dev",
    });

    const greet = await (await post(rpc("tools/call", { name: "greet", arguments: { language: "hu" } }, 4))).json();
    expect(greet.result.content[0].text).toBe("Szia, Tamas Test!");
  });

  it("refuses GET (no SSE stream in stateless mode)", async () => {
    const { app, devIssuer } = await devApp();
    const res = await app.request("http://localhost/mcp", { headers: mcpHeaders(await devIssuer.mint()) });
    expect(res.status).toBe(405);
  });
});
