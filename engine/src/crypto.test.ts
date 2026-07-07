import { beforeAll, describe, expect, it } from "vitest";

// AES-256-GCM roundtrip (spec §5.9). The key is read from config at call
// time, so pin the env before the module graph loads.

process.env.NPMGUARD_ENCRYPTION_KEY = "ab".repeat(32);

let crypto: typeof import("./crypto.js");

beforeAll(async () => {
  crypto = await import("./crypto.js");
});

describe("encryptSecret / decryptSecret", () => {
  it("roundtrips arbitrary secrets", () => {
    const secret = "gho_userAccessToken1234🔐";
    const blob = crypto.encryptSecret(secret);
    expect(blob).not.toContain(secret);
    expect(crypto.decryptSecret(blob)).toBe(secret);
  });

  it("produces distinct ciphertexts per call (fresh IV)", () => {
    expect(crypto.encryptSecret("same")).not.toBe(crypto.encryptSecret("same"));
  });

  it("rejects tampered blobs (GCM auth)", () => {
    const blob = crypto.encryptSecret("secret");
    const [iv, tag, ct] = blob.split(".");
    const flipped = Buffer.from(ct!, "base64");
    flipped[0] = flipped[0]! ^ 0xff;
    expect(() =>
      crypto.decryptSecret([iv, tag, flipped.toString("base64")].join(".")),
    ).toThrow();
  });

  it("rejects malformed blobs", () => {
    expect(() => crypto.decryptSecret("not-a-blob")).toThrow(/Malformed/);
  });
});
