import { describe, expect, it, beforeAll } from "vitest";
import { encryptField, decryptField, last4, DecryptionError, EncryptionConfigError } from "../src/encryption";

const TEST_KEY = Buffer.alloc(32, 7).toString("base64"); // deterministic, test-only

describe("encryptField / decryptField", () => {
  beforeAll(() => {
    process.env.PII_ENCRYPTION_KEY = TEST_KEY;
    process.env.PII_ENCRYPTION_KEY_ID = "v1";
  });

  it("round-trips a plaintext value exactly", () => {
    const plaintext = "ABCDE1234F"; // PAN-shaped, not a real one
    const encrypted = encryptField(plaintext);
    expect(decryptField(encrypted)).toBe(plaintext);
  });

  it("produces a different ciphertext each time (random IV)", () => {
    const a = encryptField("same-input");
    const b = encryptField("same-input");
    expect(a).not.toBe(b);
    expect(decryptField(a)).toBe("same-input");
    expect(decryptField(b)).toBe("same-input");
  });

  it("detects tampering -- flipping a character in the ciphertext fails to decrypt", () => {
    const encrypted = encryptField("sensitive-value");
    const parts = encrypted.split(":");
    const ciphertext = parts[3]!;
    const tamperedChar = ciphertext[0] === "A" ? "B" : "A";
    const tampered = [...parts.slice(0, 3), tamperedChar + ciphertext.slice(1)].join(":");

    expect(() => decryptField(tampered)).toThrow(DecryptionError);
  });

  it("rejects a malformed stored value", () => {
    expect(() => decryptField("not-even-close-to-valid")).toThrow(DecryptionError);
  });

  it("rejects a value encrypted under a different key id", () => {
    const encrypted = encryptField("value");
    const withWrongKeyId = "v2" + encrypted.slice(2);
    expect(() => decryptField(withWrongKeyId)).toThrow(DecryptionError);
  });

  it("throws a clear config error when the key is missing", () => {
    const saved = process.env.PII_ENCRYPTION_KEY;
    delete process.env.PII_ENCRYPTION_KEY;
    expect(() => encryptField("x")).toThrow(EncryptionConfigError);
    process.env.PII_ENCRYPTION_KEY = saved;
  });

  it("throws a clear config error when the key is the wrong length", () => {
    const saved = process.env.PII_ENCRYPTION_KEY;
    process.env.PII_ENCRYPTION_KEY = Buffer.alloc(16).toString("base64"); // too short
    expect(() => encryptField("x")).toThrow(EncryptionConfigError);
    process.env.PII_ENCRYPTION_KEY = saved;
  });
});

describe("last4", () => {
  it("returns the last 4 characters", () => {
    expect(last4("ABCDE1234F")).toBe("234F");
  });
});

describe("auth tag length guard", () => {
  it("rejects a stored value with a truncated auth tag before ever calling decipher", () => {
    process.env.PII_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    process.env.PII_ENCRYPTION_KEY_ID = "v1";
    const encrypted = encryptField("value");
    const parts = encrypted.split(":");
    const shortAuthTag = Buffer.from(parts[2]!, "base64").subarray(0, 8).toString("base64");
    const tampered = [parts[0], parts[1], shortAuthTag, parts[3]].join(":");

    expect(() => decryptField(tampered)).toThrow(DecryptionError);
  });
});
