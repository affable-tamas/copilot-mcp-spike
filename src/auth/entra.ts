import { createRemoteJWKSet, decodeJwt, jwtVerify, errors, type JWTVerifyGetKey } from "jose";
import type { Config } from "../config.js";
import { AuthError, identityFromClaims, type TokenVerifier, type UserIdentity } from "./identity.js";

const LOGIN = "https://login.microsoftonline.com";

/**
 * Validates Entra ID access tokens issued for this server's app registration.
 * Accepts both v1 (sts.windows.net) and v2 (login.microsoftonline.com/.../v2.0) tokens,
 * since which one is issued depends on the API app's `accessTokenAcceptedVersion`.
 */
export class EntraTokenVerifier implements TokenVerifier {
  constructor(
    private readonly config: Config["entra"],
    // The "common" key set is shared by all tenants, so it works for single- and multi-tenant apps.
    private readonly jwks: JWTVerifyGetKey = createRemoteJWKSet(new URL(`${LOGIN}/common/discovery/v2.0/keys`)),
  ) {}

  async verify(token: string): Promise<UserIdentity> {
    let tid: unknown;
    try {
      tid = decodeJwt(token).tid;
    } catch {
      throw new AuthError("Malformed token");
    }
    if (typeof tid !== "string" || !this.isTenantAllowed(tid)) {
      throw new AuthError("Tenant not allowed");
    }

    let payload;
    try {
      ({ payload } = await jwtVerify(token, this.jwks, {
        algorithms: ["RS256"],
        audience: this.config.audiences,
        issuer: [`${LOGIN}/${tid}/v2.0`, `https://sts.windows.net/${tid}/`],
        clockTolerance: 60,
      }));
    } catch (err) {
      if (err instanceof errors.JWTExpired) throw new AuthError("Token expired");
      if (err instanceof errors.JOSEError) throw new AuthError(`Token validation failed: ${err.code}`);
      throw err;
    }

    const identity = identityFromClaims(payload, "entra");
    // App-only tokens (client credentials) carry `roles` but no `scp`; they don't represent a user.
    if (!identity.scopes.includes(this.config.requiredScope)) {
      throw new AuthError(`Token lacks delegated scope "${this.config.requiredScope}"`, "insufficient_scope");
    }
    return identity;
  }

  private isTenantAllowed(tid: string): boolean {
    const { tenantId, allowedTenants } = this.config;
    if (allowedTenants.length > 0) return allowedTenants.includes(tid);
    if (tenantId === "organizations" || tenantId === "common") return true;
    return tid === tenantId;
  }
}
