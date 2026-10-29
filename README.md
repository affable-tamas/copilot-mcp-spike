# copilot-mcp-spike

An MCP server built on [Hono](https://hono.dev) and the official MCP TypeScript SDK. It is meant to be
called from **Microsoft 365 Copilot Chat** (declarative agents / Copilot Studio) and **Copilot Cowork**,
and it identifies the **signed-in user** on every request by validating their Entra ID access token.

- Transport: MCP Streamable HTTP, **stateless**, JSON responses (`POST /mcp`). Any App Service instance
  can serve any request, so you don't need session affinity.
- Auth: OAuth 2.0 bearer tokens from Microsoft Entra ID (v1 and v2 tokens), checked against Entra's
  signing keys, the audience, the issuer and tenant, and the `access_as_user` delegated scope. Unauthenticated
  calls get `401` with a `WWW-Authenticate` header that points to
  `/.well-known/oauth-protected-resource` (RFC 9728), as the MCP authorization spec requires.
- Identity reaches tools as `extra.authInfo.extra.user` (`oid`, `tid`, `name`, `username`, `clientAppId`, `scopes`).
- Each request writes a JSON log line with the user, the calling client app ID and the MCP method or tool.
  That makes it easy to see what Copilot Chat and Cowork actually send.

```
src/
  index.ts          Node entry point (@hono/node-server); reads PORT
  app.ts            Hono routes: /mcp, /.well-known/oauth-protected-resource, /healthz, /dev/token (dev only)
  mcp.ts            MCP server + tools (whoami, greet)
  config.ts         Environment configuration
  auth/entra.ts     Entra ID access-token verifier
  auth/dev.ts       Local token issuer that mints Entra-shaped tokens for offline testing
  auth/identity.ts  UserIdentity type and claim mapping
scripts/            dev-token.ts (get a local token), smoke.ts (end-to-end MCP client check)
test/               vitest tests (no network needed)
```

## Run locally

```bash
npm install
cp .env.example .env        # AUTH_MODE=dev by default
npm run dev                 # http://localhost:3000/mcp
npm run smoke               # in another shell: lists tools and calls whoami as a dev user
npm test
```

**Dev mode** (`AUTH_MODE=dev`) creates an in-memory RSA key at startup and serves `POST /dev/token`.
Tokens from that endpoint carry Entra-shaped claims, so tools see the same identity fields they would in production:

```bash
TOKEN=$(npm run -s token -- --name "Ada Lovelace" --username ada@contoso.dev)
curl -s localhost:3000/mcp -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"whoami","arguments":{}}}'
```

You can also use **MCP Inspector**: `npx @modelcontextprotocol/inspector`. Choose transport "Streamable HTTP",
set the URL to `http://localhost:3000/mcp`, and paste the token as a Bearer token.

The server refuses to start in dev mode on Azure App Service, which it detects through `WEBSITE_SITE_NAME`.

**Local testing with real Entra tokens:** set `AUTH_MODE=entra` and the `ENTRA_*` values in `.env`, then run:

```bash
az login --tenant <tenant-id>
npm run smoke -- --token "$(az account get-access-token --scope api://<client-id>/access_as_user --query accessToken -o tsv)"
```

For this to work, the Azure CLI (`04b07795-8ddb-461a-bbee-02f9e1bf7b46`) must be an authorized client application
on the API's exposed scope, or must be consented. To let Copilot reach a local server, use a dev tunnel
(`devtunnel host -p 3000 --allow-anonymous`) and set `PUBLIC_BASE_URL` to the tunnel URL.

## Entra ID app registration

One app registration can serve as both the API (audience) and the OAuth client that Copilot uses.
That is the simplest setup for a spike. Production can split them.

```bash
APP_ID=$(az ad app create --display-name copilot-mcp-spike --sign-in-audience AzureADMyOrg \
  --query appId -o tsv)
OBJ_ID=$(az ad app show --id $APP_ID --query id -o tsv)
SCOPE_ID=$(uuidgen)

# App ID URI, a delegated scope, and v2 access tokens
az ad app update --id $APP_ID --identifier-uris "api://$APP_ID"
az rest --method PATCH --url "https://graph.microsoft.com/v1.0/applications/$OBJ_ID" --body "{
  \"api\": {
    \"requestedAccessTokenVersion\": 2,
    \"oauth2PermissionScopes\": [{
      \"id\": \"$SCOPE_ID\", \"value\": \"access_as_user\", \"type\": \"User\", \"isEnabled\": true,
      \"adminConsentDisplayName\": \"Use copilot-mcp-spike as the signed-in user\",
      \"adminConsentDescription\": \"Allows Copilot to call copilot-mcp-spike on behalf of the signed-in user.\"
    }]
  }
}"
az ad sp create --id $APP_ID

# Client secret for the Copilot OAuth configuration
az ad app credential reset --id $APP_ID --display-name copilot --query password -o tsv
```

Add these **web redirect URIs** (Authentication blade, or `az ad app update --web-redirect-uris ...`):

| Client | Redirect URI |
| --- | --- |
| M365 Copilot declarative agents and Cowork (OAuth registration in the Teams Developer Portal) | `https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect` |
| Copilot Studio (MCP onboarding wizard / custom connector) | Copy the redirect URL that the wizard shows after you save the connection |

The OAuth values Copilot asks for:

| Field | Value |
| --- | --- |
| Authorization URL | `https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/authorize` |
| Token URL | `https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/token` |
| Refresh URL | same as token URL |
| Client ID / secret | from above |
| Scope | `api://<client-id>/access_as_user offline_access` |

Entra ID doesn't support dynamic client registration, so configure the client manually. Don't rely on
automatic discovery.

## Deploy to Azure App Service (Linux, Node 22)

```bash
RG=rg-copilot-mcp-spike; APP=copilot-mcp-spike-<unique>; LOC=westeurope
az group create -n $RG -l $LOC
az appservice plan create -g $RG -n $APP-plan --is-linux --sku B1
az webapp create -g $RG -p $APP-plan -n $APP --runtime "NODE:22-lts"
az webapp config set -g $RG -n $APP --startup-file "npm start" --always-on true --http20-enabled true
az webapp config appsettings set -g $RG -n $APP --settings \
  AUTH_MODE=entra ENTRA_TENANT_ID=<tenant-id> ENTRA_CLIENT_ID=$APP_ID \
  SCM_DO_BUILD_DURING_DEPLOYMENT=true
az webapp update -g $RG -n $APP --https-only true
az webapp config set -g $RG -n $APP --generic-configurations '{"healthCheckPath": "/healthz"}'

# Deploy the source; Oryx runs `npm install` and `npm run build` on the server
git archive -o app.zip HEAD
az webapp deploy -g $RG -n $APP --src-path app.zip --type zip
```

- Leave **App Service Authentication (Easy Auth) off**. The app validates tokens itself and has to return its own
  `401` with `WWW-Authenticate` so MCP clients can discover how to authenticate. Easy Auth would redirect or
  answer with its own response instead.
- The public base URL defaults to `https://$WEBSITE_HOSTNAME`. Set `PUBLIC_BASE_URL` if you use a custom domain.
- Logs: `az webapp log tail -g $RG -n $APP`. Look for `mcp_request` and `auth_failed` entries.
- Check it: `npm run smoke -- --url https://$APP.azurewebsites.net --token "$(az account get-access-token --scope api://$APP_ID/access_as_user --query accessToken -o tsv)"`

## Connect from Copilot

**Copilot Chat via a declarative agent (Microsoft 365 Agents Toolkit):** use *Add Action → Start with an MCP server*,
enter `https://<app>.azurewebsites.net/mcp`, and pick OAuth. The toolkit generates the plugin manifest and an
OAuth registration (`OAuthPluginVault`) using the values above. Roughly, the generated runtime looks like this
(regenerate with the toolkit rather than hand-editing):

```json
"runtimes": [{
  "type": "RemoteMCPServer",
  "spec": { "url": "https://<app>.azurewebsites.net/mcp" },
  "run_for_functions": ["whoami", "greet"],
  "auth": { "type": "OAuthPluginVault", "reference_id": "<oauth-registration-id>" }
}]
```

**Copilot Studio:** Tools → Add tool → Model Context Protocol. Enter the server URL, choose OAuth 2.0 (manual),
and fill in the table above. Then add the copied redirect URI to the app registration.

**Copilot Cowork:** register the server as a connector in a Cowork plugin. Its auth is declared under the
Microsoft 365 app manifest's `agentConnectors` node, using the same OAuth registration model as declarative-agent
plugins, so the OAuth registration above can be reused.

### Tell the clients apart

`whoami` returns `clientAppId` (the token's `azp`/`appid`) and the `User-Agent`. The `initialize` log line
records `clientInfo` too. If Chat and Cowork use different OAuth registrations, `clientAppId` tells them apart reliably.
Otherwise, use the logged `clientInfo` and `User-Agent` values once you have seen what each surface sends.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `AUTH_MODE` | `entra` | `dev` for locally minted tokens |
| `PORT` | `3000` | App Service sets this |
| `ENTRA_TENANT_ID` | | Tenant GUID, or `organizations` for multi-tenant |
| `ENTRA_CLIENT_ID` | | API app registration's application ID |
| `ENTRA_APP_ID_URI` | `api://<client-id>` | Accepted as the audience alongside the client ID |
| `ENTRA_REQUIRED_SCOPE` | `access_as_user` | Required in `scp`; app-only tokens are rejected |
| `ENTRA_ALLOWED_TENANTS` | | Comma-separated allow-list for multi-tenant |
| `PUBLIC_BASE_URL` | `https://$WEBSITE_HOSTNAME` | Otherwise derived from the request / `X-Forwarded-*` |
| `MCP_RESOURCE_ID` | `<base>/mcp` | Overrides the `resource` in protected-resource metadata |

## Next steps

- **Call Microsoft Graph or other APIs as the user:** exchange the incoming token with the on-behalf-of flow
  (`@azure/msal-node` `acquireTokenOnBehalfOf`). The token and identity are already on `extra.authInfo`.
- Use `oid` (together with `tid`) as the key for per-user data. `username` can change.
