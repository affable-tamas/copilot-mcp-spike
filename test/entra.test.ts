import { describe, expect, it } from "vitest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { EntraTokenVerifier } from "../src/auth/entra.js";
import { loadConfig } from "../src/config.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
const CLIENT = "22222222-2222-2222-2222-222222222222";

async function setup(env: Record<string, string> = {}) {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  const config = loadConfig({ ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT, ...env });
  const verifier = new EntraTokenVerifier(config.entra, createLocalJWKSet({ keys: [jwk] }));
  const sign = (claims: Record<string, unknown>, iss: string, aud: string) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(iss)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
  return { verifier, sign };
}

const user = (tid = TENANT) => ({
  oid: "33333333-3333-3333-3333-333333333333",
  tid,
  name: "Ada Lovelace",
  upn: "ada@contoso.com",
  appid: "copilot-connector-app",
  scp: "access_as_user",
});

describe("EntraTokenVerifier", () => {
  it("accepts a v2 token (aud = client ID)", async () => {
    const { verifier, sign } = await setup();
    const id = await verifier.verify(await sign(user(), `https://login.microsoftonline.com/${TENANT}/v2.0`, CLIENT));
    expect(id).toMatchObject({ oid: user().oid, username: "ada@contoso.com", clientAppId: "copilot-connector-app" });
  });

  it("accepts a v1 token (aud = App ID URI)", async () => {
    const { verifier, sign } = await setup();
    const id = await verifier.verify(await sign(user(), `https://sts.windows.net/${TENANT}/`, `api://${CLIENT}`));
    expect(id.name).toBe("Ada Lovelace");
  });

  it("rejects the wrong audience", async () => {
    const { verifier, sign } = await setup();
    const token = await sign(user(), `https://login.microsoftonline.com/${TENANT}/v2.0`, "https://graph.microsoft.com");
    await expect(verifier.verify(token)).rejects.toThrow(/validation failed/);
  });

  it("rejects a foreign tenant unless allowed", async () => {
    const other = "44444444-4444-4444-4444-444444444444";
    const iss = `https://login.microsoftonline.com/${other}/v2.0`;
    const single = await setup();
    await expect(single.verifier.verify(await single.sign(user(other), iss, CLIENT))).rejects.toThrow(/Tenant/);

    const multi = await setup({ ENTRA_TENANT_ID: "organizations", ENTRA_ALLOWED_TENANTS: `${TENANT},${other}` });
    expect((await multi.verifier.verify(await multi.sign(user(other), iss, CLIENT))).tid).toBe(other);
  });

  it("rejects an issuer that does not match the token's tenant", async () => {
    const { verifier, sign } = await setup();
    const token = await sign(user(), "https://login.microsoftonline.com/44444444-4444-4444-4444-444444444444/v2.0", CLIENT);
    await expect(verifier.verify(token)).rejects.toThrow(/validation failed/);
  });

  it("rejects app-only tokens, which carry no user", async () => {
    const { verifier, sign } = await setup();
    const { scp: _scp, ...appOnly } = { ...user(), roles: ["Tools.Invoke"] };
    const token = await sign(appOnly, `https://login.microsoftonline.com/${TENANT}/v2.0`, CLIENT);
    await expect(verifier.verify(token)).rejects.toMatchObject({ code: "insufficient_scope" });
  });
});
