---
name: copilot-mcp-spike-identity
description: Checks which Microsoft 365 user the copilot-mcp-spike MCP server sees, and greets them. Use when the user asks "who am I", "whoami", "what identity does the MCP server see", "test the MCP connector", "check the copilot-mcp-spike connection", or asks for a greeting from the MCP server.
metadata:
  author: Affable Co.
  version: 1.0.0
---

# Copilot MCP spike identity check

This skill tests the **Copilot MCP spike** connector. The connector's MCP server validates the user's Entra ID
token on every call and reports the identity it sees.

## Tools

- `whoami` (read-only, no inputs): returns `oid`, `tenantId`, `name`, `username`, `clientAppId`, `scopes`,
  `userAgent` and `tokenSource`.
- `greet` (read-only): takes `language` (`en`, `hu`, `de` or `fr`, default `en`) and returns a greeting with
  the user's name.

## Steps

1. Call `whoami`.
2. Report the result as a short table: name, username, object ID (`oid`), tenant ID, client app ID, scopes,
   user agent and token source. Don't invent values. If a field is missing, say it's missing.
3. If the user asked for a greeting, or asked for a general test of the connector, also call `greet`. Use the
   language the user asked for, otherwise `en`. Quote the greeting exactly.
4. If a tool call fails, quote the error exactly. Then suggest the user sign in to the connector again
   (Cowork → Sources & Skills). Don't retry more than once.

Don't call any other connector to answer these questions. The point is to see what this server receives.
