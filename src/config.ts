export type AuthMode = "entra" | "dev";

export interface Config {
  port: number;
  /** Public origin of this server, e.g. https://my-app.azurewebsites.net. Undefined = derive from the request. */
  publicBaseUrl?: string;
  authMode: AuthMode;
  entra: {
    /** Directory (tenant) ID, or "organizations" for a multi-tenant app. */
    tenantId: string;
    /** Application (client) ID of the app registration that represents this MCP server (the API). */
    clientId: string;
    /** Accepted `aud` values. Entra issues `clientId` for v2 tokens and the App ID URI for v1 tokens. */
    audiences: string[];
    /** Tenants whose users may call the server. Empty = only `tenantId` (or any tenant when tenantId is "organizations"). */
    allowedTenants: string[];
    /** Delegated scope the token must carry, e.g. "access_as_user". */
    requiredScope: string;
  };
  /** Overrides the `resource` value advertised in protected resource metadata. */
  resourceId?: string;
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const authMode = (env.AUTH_MODE ?? "entra") as AuthMode;
  if (authMode !== "entra" && authMode !== "dev") {
    throw new Error(`AUTH_MODE must be "entra" or "dev", got "${authMode}"`);
  }
  // WEBSITE_SITE_NAME is set by Azure App Service. Never run with forgeable dev tokens there.
  if (authMode === "dev" && env.WEBSITE_SITE_NAME) {
    throw new Error("AUTH_MODE=dev is not allowed on Azure App Service");
  }

  const tenantId = env.ENTRA_TENANT_ID ?? "";
  const clientId = env.ENTRA_CLIENT_ID ?? "";
  if (authMode === "entra" && (!tenantId || !clientId)) {
    throw new Error("ENTRA_TENANT_ID and ENTRA_CLIENT_ID are required when AUTH_MODE=entra");
  }

  const appIdUri = env.ENTRA_APP_ID_URI ?? (clientId ? `api://${clientId}` : "");
  const publicBaseUrl =
    env.PUBLIC_BASE_URL ?? (env.WEBSITE_HOSTNAME ? `https://${env.WEBSITE_HOSTNAME}` : undefined);

  return {
    port: Number(env.PORT ?? 3000),
    publicBaseUrl: publicBaseUrl?.replace(/\/+$/, ""),
    authMode,
    entra: {
      tenantId,
      clientId,
      audiences: [clientId, appIdUri].filter(Boolean),
      allowedTenants: list(env.ENTRA_ALLOWED_TENANTS),
      requiredScope: env.ENTRA_REQUIRED_SCOPE ?? "access_as_user",
    },
    resourceId: env.MCP_RESOURCE_ID,
  };
}
