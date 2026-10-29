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
scripts/            dev-token.ts (get a local token), smoke.ts (end-to-end MCP client check),
                    tool-description.ts (toolDescription.json for Microsoft 365 app packages)
test/               vitest tests (no network needed)
cowork/             Copilot Cowork plugin (skill + connector) for the dev deployment; see "The cowork/ plugin"
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

# The app is also the OAuth client, so it requests a delegated permission to its own scope.
# Without this, sign-in can fail with AADSTS650057 (resource not listed in the client's required permissions).
az ad app permission add --id $APP_ID --api $APP_ID --api-permissions $SCOPE_ID=Scope
# Tenant-wide (admin) consent for that permission. --scope takes the scope's value, not its ID.
az ad app permission grant --id $APP_ID --api $APP_ID --scope access_as_user
az ad app permission list-grants --id $APP_ID --query "[].scope" -o tsv   # should print: access_as_user

# Client secret for the Copilot OAuth configuration
az ad app credential reset --id $APP_ID --display-name copilot --query password -o tsv
```

With `requestedAccessTokenVersion: 2`, the token's `aud` is the client ID, whichever App ID URI the scope was
requested through. The server also accepts `api://<client-id>` (or `ENTRA_APP_ID_URI`) for v1 tokens.

**Redirect URIs.** Add these on the app registration (Authentication → Web):

| Client | Redirect URI |
| --- | --- |
| Copilot Chat declarative agents and Cowork, OAuth 2.0 auth config | `https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect` |
| Copilot Chat declarative agents and Cowork, Entra SSO auth config | `https://teams.microsoft.com/api/platform/v1.0/oAuthConsentRedirect` |
| Copilot Studio | The connector's callback URL; see below |

The Teams redirect URI is the same for every plugin and provider. If it isn't registered, sign-in fails.

**Copilot Studio callback URL.** When you add the MCP server in Copilot Studio (Tools → Add a tool → New tool →
Model Context Protocol) with OAuth 2.0 → Manual, Copilot Studio creates a Power Platform custom connector for it.
That connector gets its own callback URL, of the form
`https://global.consent.azure-apim.net/redirect/<connector-name>-<id>`. The URL only exists once the connector has
been created, so you can't register it in Entra ahead of time:

1. Select **Create** in the wizard. A callback URL appears. You can also find it later as the **Redirect URL** on
   the connector's **Security** tab (Power Apps or Power Automate → Custom connectors).
2. Add that exact URL as a web redirect URI on the app registration. The URL doesn't change when you update the
   connector, but exporting the connector to another environment creates a new one.
3. Create the connection (sign in). Until step 2 is done, sign-in fails with Entra's redirect URI mismatch error
   (`AADSTS50011`).

**OAuth values.** Copilot asks for these:

| Field | Value |
| --- | --- |
| Authorization URL | `https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/authorize` |
| Token URL | `https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/token` |
| Refresh URL | Same as the token URL |
| Client ID / secret | From above |
| Scope | `api://<client-id>/access_as_user offline_access` |

`offline_access` lets the Microsoft 365 token store refresh tokens. Entra ID has no dynamic client registration
(RFC 7591) endpoint, so the "Dynamic" and "Dynamic discovery" options in Copilot Studio and "OAuth (with dynamic
registration)" in Agents Toolkit don't work with it. Use static (manual) registration.

### The `resource` parameter and generic MCP clients

Clients that follow the MCP authorization spec, such as VS Code and MCP Inspector's OAuth flow, send
`resource=<server URL>/mcp` to Entra together with the `api://<client-id>/access_as_user` scope. Entra rejects
this with `AADSTS9010010` ("The resource parameter provided in the request doesn't match with the requested
scopes"), because the resource doesn't match the scope's App ID URI. The only clean fix is an App ID URI equal to the
server URL, for example `https://mcp.contoso.com/mcp`. Entra allows https App ID URIs only on a tenant-verified
domain, and `*.azurewebsites.net` can't be verified. So you need a custom domain on App Service, and you set
`ENTRA_APP_ID_URI=https://mcp.contoso.com/mcp`.

Copilot Chat, Cowork and Copilot Studio use the scope configured in their OAuth settings and don't run into this.
You only need the custom domain if generic MCP clients also have to sign in on their own.

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

- Leave **App Service Authentication (Easy Auth) off**. The app validates tokens and serves the protected resource
  metadata itself, so it runs the same way locally and on Azure.
  - App Service also has built-in MCP server authorization (preview). It serves the metadata from the
    `WEBSITE_AUTH_PRM_DEFAULT_WITH_SCOPES` app setting and validates tokens before they reach the app.
  - If you switch to that, make sure the Copilot client app is allowed in Easy Auth's authorization policy. The
    default policy only allows tokens the app obtained itself.
  - That path hasn't been tested with this server.
- The public base URL defaults to `https://$WEBSITE_HOSTNAME`. Set `PUBLIC_BASE_URL` if you use a custom domain.
- Logs: `az webapp log tail -g $RG -n $APP`. Look for `mcp_request` and `auth_failed` entries.
- Check it: `npm run smoke -- --url https://$APP.azurewebsites.net --token "$(az account get-access-token --scope api://$APP_ID/access_as_user --query accessToken -o tsv)"`

## Connect from Copilot

Copilot Chat (declarative agents) and Cowork share one OAuth auth config, stored in the Microsoft Enterprise token
store and referenced by ID. Copilot Studio has its own connection. All of them use Streamable HTTP. Copilot Studio
dropped SSE in August 2025.

### Teams Developer Portal auth config (Copilot Chat and Cowork)

Agents Toolkit creates this for you. You can also create it in the [Teams Developer Portal](https://dev.teams.microsoft.com)
under Tools → OAuth client registration. Either way, check these settings:

- **Base URL**: the MCP server URL (`https://<app>.azurewebsites.net/mcp`). If it doesn't match the server URL in
  the manifest, sign-in fails with "The base URL in your authentication configuration does not match the server URL".
- **Restrict usage by app**: **Any Teams app**. A registration bound to a specific Teams app ID provisions
  successfully, but then every tool call returns 404.
- **Restrict usage by org**: **Any Microsoft 365 organization** for Cowork. The Cowork docs require it, even for a
  single tenant.
- **Client ID**: watch for stray whitespace. One reported Cowork failure (tool calls failing after a successful sign-in)
  was traced to a trailing space in the client ID.
- **PKCE** is on by default. Leave it on.

The registration ID it produces is the `reference_id` / `referenceId` used in the manifests below.

**Entra SSO** instead of OAuth (no sign-in prompt, no client secret) needs these extra steps:

- Add the Application ID URI that the portal generates to the app registration's `identifierUris`, using the
  manifest editor.
- Add the `oAuthConsentRedirect` redirect URI.
- Pre-authorize the Microsoft Enterprise token store client `ab3be6b7-f5df-413d-ac2d-abf1e3fd9c0b` on the
  `access_as_user` scope.

Tokens still arrive as normal v2 tokens with `aud` = client ID, so the server needs no change. `azp` is then the
token store's client ID.

### Copilot Chat via a declarative agent (Microsoft 365 Agents Toolkit 6.12+)

1. Create a new agent: **Declarative Agent**, then **Add an Action → Start with an MCP Server**.
2. Enter `https://<app>.azurewebsites.net/mcp`.
3. Pick **OAuth (with static registration)** and enter the client ID, secret and scope. You can pick **Entra SSO**
   instead.

The toolkit reads the authorization and token endpoints from the server's well-known metadata
(`/.well-known/oauth-protected-resource`). It then creates the auth config and writes it into `ai-plugin.json`:

```json
"auth": { "type": "OAuthPluginVault", "reference_id": "<auth config ID>" }
```

The generated manifest discovers tools dynamically at runtime. Users can sign out under Chat settings → Agents.

### Copilot Cowork (plugin)

A Cowork plugin is a Microsoft 365 app package with a skill (`skills/<name>/SKILL.md`) and a connector under
`agentConnectors`. Cowork reuses the same auth config as the declarative agent:

```json
"agentConnectors": [{
  "id": "copilot-mcp-spike",
  "displayName": "Copilot MCP spike",
  "description": "Identifies the signed-in user.",
  "toolSource": {
    "remoteMcpServer": {
      "mcpServerUrl": "https://<app>.azurewebsites.net/mcp",
      "authorization": { "type": "OAuthPluginVault", "referenceId": "<auth config ID>" },
      "mcpToolDescription": { "file": "toolDescription.json" }
    }
  }
}]
```

- `agentConnectors` has no Entra-specific authorization type, so use `OAuthPluginVault`. It can reference either an
  OAuth or an Entra SSO auth config.
- **Tool description file.** At manifest version 1.28, `mcpToolDescription` is required and the file must be in the
  zip. At 1.29 (what `wiqd plugin create` generates) it's optional. The Cowork docs say Cowork discovers tools
  dynamically and ignores the file. Generate it from the server with `npm run tool-description` so it stays in sync.
- Scaffold, validate and package with the `wiqd` CLI (`wiqd plugin create`, `wiqd plugin add connector`,
  `wiqd plugin validate --mode deep`). Then upload through the Microsoft 365 admin center, or sideload with
  `atk install --file-path <zip> --scope Personal`. This repo's plugin is built with `atk` instead; see below.
- **Known issue.** A [Microsoft Q&A thread](https://learn.microsoft.com/en-gb/answers/questions/5919386/m365-copilot-cowork-frontier-remote-mcp-connector)
  (June to August 2026) reports Cowork tool calls failing after a successful OAuth sign-in. No authenticated tool
  call reaches the server, while the same config works in Copilot Chat. There's no official fix. The `auth_failed`
  and `mcp_request` log lines show whether a token arrives.
- One write-up (May 2026) needed the app registrations set to multi-tenant before Cowork's **Connect** worked. The
  server still accepts only `ENTRA_TENANT_ID` unless `ENTRA_ALLOWED_TENANTS` says otherwise.

#### The `cowork/` plugin in this repo

`cowork/` is a working Cowork plugin for the dev deployment (`copilot-mcp-spike-dev.azurewebsites.net`). It has one
skill (`copilot-mcp-spike-identity`, which calls `whoami` and `greet`) and the connector above. It's an Agents
Toolkit project, so you only need the `atk` CLI (`npm install -g @microsoft/m365agentstoolkit-cli`), not `wiqd`.

```
cowork/
  m365agents.yml             provision: oauth/register (Developer Portal auth config), then teamsApp/zipAppPackage
  env/.env.dev               URL, tenant, client ID, Teams app ID, and OAUTH_CONFIGURATION_ID once provisioned
  env/.env.dev.user          SECRET_ENTRA_CLIENT_SECRET (gitignored; create it yourself)
  appPackage/manifest.json   Manifest v1.28 with ${{...}} placeholders filled from env/
  appPackage/skills/copilot-mcp-spike-identity/SKILL.md
  appPackage/toolDescription.json, color.png, outline.png
  appPackage/build/          Output zip (gitignored)
```

**Build the zip.** Run these from `cowork/`:

```bash
echo 'SECRET_ENTRA_CLIENT_SECRET=<client secret>' > env/.env.dev.user   # first time only
atk auth login m365                                                    # Developer Portal access
atk provision --env dev       # -> appPackage/build/copilot-mcp-spike-cowork.dev.zip
atk validate --package-file appPackage/build/copilot-mcp-spike-cowork.dev.zip
```

- **First run.** `oauth/register` creates the Developer Portal auth config, using the settings Cowork needs: Any
  Teams app, Any Microsoft 365 organization, PKCE on, and scope `api://<client-id>/access_as_user offline_access`.
  The action splits scopes on commas, so `m365agents.yml` lists them comma-separated. It writes the registration ID
  to `OAUTH_CONFIGURATION_ID` in `env/.env.dev`, and the manifest's `referenceId` comes from there.
- **Later runs.** The existing registration is kept and only the zip is rebuilt. To create a new registration,
  delete the `OAUTH_CONFIGURATION_ID` line first.

**Install it.** Sideload it for yourself:

```bash
atk install --file-path appPackage/build/copilot-mcp-spike-cowork.dev.zip --scope Personal
```

`atk install` prints a `TitleId` and an `AppId`; save them. You can also upload the zip for the whole tenant in the
Microsoft 365 admin center (Manage apps → Upload custom app). The plugin then shows up in Cowork under Sources &
Skills → Plugins. Sign in to the connector there, then ask "who am I?".

**Change it:**

- **Skill or manifest text.** Edit the files under `appPackage/` and bump `version` in `manifest.json`. Then run
  `atk provision --env dev` and `atk install` again. Keep the `TEAMS_APP_ID` (the manifest `id`) stable, so the new
  package updates the installed app instead of adding a second one.
- **Server tools.** Run `npm run tool-description -- --out cowork/appPackage/toolDescription.json` from the repo
  root, then rebuild the zip.
- **Another deployment.** Copy `env/.env.dev` to `env/.env.<name>` and change `MCP_BASE_URL` and the Entra IDs.
  Remove `OAUTH_CONFIGURATION_ID`, and use a new `TEAMS_APP_ID` (`uuidgen`). Then run `atk provision --env <name>`.
  The auth config's base URL must match the connector's `mcpServerUrl`, so each server URL needs its own registration.
- **Client secret rotation.** The Developer Portal registration stores its own copy of the secret, so updating
  `env/.env.dev.user` isn't enough. Also update the secret in the [Developer Portal](https://dev.teams.microsoft.com)
  under Tools → OAuth client registration.
- **Uninstall.** Run `atk uninstall --mode title-id --title-id <TitleId>`.

The manifest's privacy and terms URLs (`/privacy`, `/terms`) aren't served by the app. That's fine for
sideloading, but store validation would fail.

### Copilot Studio

1. Go to Tools → Add a tool → New tool → **Model Context Protocol**.
2. Enter the server name, description and URL.
3. Choose OAuth 2.0 → **Manual** and enter the client ID, client secret, authorization URL, token URL template,
   refresh URL and scopes.
4. Register the callback URL as described above, then create the connection.

Generative orchestration must be on. Known limitations:

- Copilot Studio supports MCP tools and resources, not prompts.
- `enum` inputs are treated as plain strings.
- Tools with `$ref` inputs are dropped.
- Multi-type `type` arrays get truncated.

### Tell the clients apart

`whoami` returns `clientAppId` (the token's `azp`/`appid`) and the `User-Agent`. The `initialize` log line also
records `clientInfo`. With an OAuth auth config, `azp` is your own client ID on every Copilot surface, so it doesn't
separate Copilot Chat from Cowork. Use the logged `clientInfo` and `User-Agent` values once you have seen what each
surface sends. If you need a hard split, give each surface its own auth config backed by a separate client app
registration.

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

- **Call Microsoft Graph or other APIs as the user:** get a new token with the on-behalf-of flow
  (`@azure/msal-node` `acquireTokenOnBehalfOf`). Never forward the incoming token. The token and identity are already
  on `extra.authInfo`. If the downstream API needs consent, return 401 so Copilot prompts the user to sign in again.
- Use `oid` (together with `tid`) as the key for per-user data. `username` can change.

## Sources

- Microsoft Learn: [Build an MCP plugin for a declarative agent](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/build-mcp-plugins),
  [Plugin authentication](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-authentication),
  [OAuth 2.0](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-authentication-oauth),
  [Entra SSO](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-authentication-entra-sso),
  [Auth troubleshooting](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-authentication-troubleshooting),
  [Remote MCP servers in agentConnectors](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/configure-plugin-mcp-servers),
  [Cowork plugin development](https://learn.microsoft.com/en-us/microsoft-365/copilot/cowork/cowork-plugin-development)
- Microsoft Learn: [Copilot Studio: connect to an existing MCP server](https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-add-existing-server-to-agent),
  [Copilot Studio MCP troubleshooting](https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-troubleshooting),
  [Custom connector redirect URL](https://learn.microsoft.com/en-us/connectors/custom-connectors/azure-active-directory-authentication),
  [App Service built-in MCP authorization](https://learn.microsoft.com/en-us/azure/app-service/configure-authentication-mcp)
- Community: [MCP with Entra auth + Copilot & Cowork](https://nullpointer.se/copilot-cowork-oauth.html) (July 2026),
  [Secure MCP-powered Cowork plugins](https://simondoy.com/2026/05/30/my-experiences-build-secure-mcp-powered-copilot-cowork-plugins/) (May 2026),
  [Cowork MCP connector](https://www.developerscantina.com/p/cowork-mcp-connector/),
  [Q&A: Cowork OAuthPluginVault tool calls fail](https://learn.microsoft.com/en-gb/answers/questions/5919386/m365-copilot-cowork-frontier-remote-mcp-connector)
