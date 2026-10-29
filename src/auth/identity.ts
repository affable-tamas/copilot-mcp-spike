import type { JWTPayload } from "jose";

/** The user on whose behalf Copilot is calling the MCP server. */
export interface UserIdentity {
  /** Entra object ID: the stable, tenant-scoped user identifier. Use this as the key for user data. */
  oid: string;
  /** Tenant ID of the user's home directory (or guest tenant). */
  tid: string;
  /** Display name, if the token carries one. */
  name?: string;
  /** Sign-in name (UPN / preferred_username / email). Human-readable; not guaranteed stable or unique. */
  username?: string;
  /** Application ID of the client that obtained the token (e.g. the Copilot connector's app registration). */
  clientAppId?: string;
  /** Delegated scopes granted to the client. */
  scopes: string[];
  /** Token expiry, seconds since epoch. */
  expiresAt?: number;
  /** "entra" for real tokens, "dev" for locally minted ones. */
  source: "entra" | "dev";
}

export function identityFromClaims(claims: JWTPayload, source: UserIdentity["source"]): UserIdentity {
  const str = (key: string) => (typeof claims[key] === "string" ? (claims[key] as string) : undefined);
  const oid = str("oid");
  const tid = str("tid");
  if (!oid || !tid) {
    throw new AuthError("Token does not identify a user (missing oid/tid)");
  }
  return {
    oid,
    tid,
    name: str("name"),
    username: str("upn") ?? str("preferred_username") ?? str("unique_name") ?? str("email"),
    clientAppId: str("azp") ?? str("appid"),
    scopes: (str("scp") ?? "").split(" ").filter(Boolean),
    expiresAt: claims.exp,
    source,
  };
}

export class AuthError extends Error {
  constructor(
    message: string,
    /** RFC 6750 error code for the WWW-Authenticate header. */
    readonly code: "invalid_token" | "insufficient_scope" = "invalid_token",
  ) {
    super(message);
  }
}

export interface TokenVerifier {
  verify(token: string): Promise<UserIdentity>;
}
