import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createVerify, generateKeyPairSync } from "crypto";
import { createClientSecret } from "./apple-ads-api-auth";
import type { AppleAdsApiCredentials } from "./apple-ads-api-config";

describe("createClientSecret", () => {
  const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "aso-ads-api-key-"));
  const privateKeyPath = path.join(keyDir, "private-key.pem");
  let publicKeyPem: string;

  beforeAll(() => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    fs.writeFileSync(
      privateKeyPath,
      privateKey.export({ type: "sec1", format: "pem" })
    );
    publicKeyPem = publicKey
      .export({ type: "spki", format: "pem" })
      .toString();
  });

  afterAll(() => {
    fs.rmSync(keyDir, { recursive: true, force: true });
  });

  const credentials: () => AppleAdsApiCredentials = () => ({
    clientId: "SEARCHADS.client",
    teamId: "SEARCHADS.team",
    keyId: "key-id-1",
    privateKeyPath,
    orgId: null,
  });

  it("produces a JWT with Apple's expected header and claims", () => {
    const nowMs = 1_755_000_000_000;
    const jwt = createClientSecret(credentials(), nowMs);
    const [headerPart, payloadPart] = jwt.split(".");
    const header = JSON.parse(Buffer.from(headerPart, "base64url").toString());
    const payload = JSON.parse(
      Buffer.from(payloadPart, "base64url").toString()
    );
    expect(header).toEqual({ alg: "ES256", kid: "key-id-1" });
    expect(payload).toEqual({
      sub: "SEARCHADS.client",
      iss: "SEARCHADS.team",
      aud: "https://appleid.apple.com",
      iat: 1_755_000_000,
      exp: 1_755_000_000 + 3600,
    });
  });

  it("signs with ES256 raw (r||s) signatures the public key verifies", () => {
    const jwt = createClientSecret(credentials());
    const [headerPart, payloadPart, signaturePart] = jwt.split(".");
    const signature = Buffer.from(signaturePart, "base64url");
    // The raw JWT signature format is exactly 64 bytes for P-256.
    expect(signature.length).toBe(64);
    const verifier = createVerify("SHA256");
    verifier.update(`${headerPart}.${payloadPart}`);
    expect(
      verifier.verify(
        { key: publicKeyPem, dsaEncoding: "ieee-p1363" },
        signature
      )
    ).toBe(true);
  });
});
