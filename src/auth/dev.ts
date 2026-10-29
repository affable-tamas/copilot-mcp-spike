import { randomUUID } from "node:crypto";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, type JWK } from "jose";
import { AuthError, identityFromClaims, type TokenVerifier, type UserIdentity } from "./identity.js";

export const DEV_ISSUER = "urn:copilot-mcp-spike:dev";
export const DEV_AUDIENCE = "urn:copilot-mcp-spike:dev-api";
export const DEV_TENANT = "00000000-0000-0000-0000-000000000000";

export interface DevUser {
  name?: string;
  username?: string;
  oid?: string;
}

/**
 * Local stand-in for Entra ID: mints and verifies RS256 tokens with Entra-shaped claims, so
 * the same identity code path runs locally without an Azure tenant. The key lives in memory.
 */
export class DevTokenIssuer implements TokenVerifier {
  private constructor(
    private readonly privateKey: CryptoKey,
    readonly publicJwk: JWK,
  ) {}

  static async create(): Promise<DevTokenIssuer> {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const publicJwk = { ...(await exportJWK(publicKey)), kid: "dev", alg: "RS256", use: "sig" };
    return new DevTokenIssuer(privateKey, publicJwk);
  }

  async mint(user: DevUser = {}): Promise<string> {
    const username = user.username ?? "alex@contoso.dev";
    return new SignJWT({
      oid: user.oid ?? deterministicOid(username),
      tid: DEV_TENANT,
      name: user.name ?? "Alex Developer",
      preferred_username: username,
      azp: "dev-client",
      scp: "access_as_user",
    })
      .setProtectedHeader({ alg: "RS256", kid: "dev" })
      .setIssuer(DEV_ISSUER)
      .setAudience(DEV_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("8h")
      .setJti(randomUUID())
      .sign(this.privateKey);
  }

  async verify(token: string): Promise<UserIdentity> {
    try {
      const { payload } = await jwtVerify(token, createLocalJWKSet({ keys: [this.publicJwk] }), {
        issuer: DEV_ISSUER,
        audience: DEV_AUDIENCE,
      });
      return identityFromClaims(payload, "dev");
    } catch (err) {
      if (err instanceof AuthError) throw err;
      throw new AuthError("Invalid dev token");
    }
  }
}

/** Same username → same oid across restarts, so per-user state keyed by oid survives local restarts. */
function deterministicOid(username: string): string {
  let h = 0n;
  for (const ch of username) h = (h * 131n + BigInt(ch.codePointAt(0)!)) & ((1n << 128n) - 1n);
  const hex = h.toString(16).padStart(32, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
