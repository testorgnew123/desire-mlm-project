import { describe, expect, it, beforeAll } from "vitest";
import { authenticator } from "otplib";
import {
  buildMfaEnrollmentUri,
  encryptMfaSecret,
  generateMfaSecret,
  verifyMfaToken,
} from "../src/auth";

describe("MFA (TOTP)", () => {
  beforeAll(() => {
    process.env.PII_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    process.env.PII_ENCRYPTION_KEY_ID = "v1";
  });

  it("generates a usable base32 secret", () => {
    const secret = generateMfaSecret();
    expect(secret).toMatch(/^[A-Z2-7]+$/); // base32 alphabet
    expect(secret.length).toBeGreaterThanOrEqual(16);
  });

  it("builds a valid otpauth:// enrollment URI", () => {
    const secret = generateMfaSecret();
    const uri = buildMfaEnrollmentUri(secret, "admin@example.test", "Desire Platform");
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain("Desire%20Platform");
  });

  it("verifies a token actually generated from the same secret", () => {
    const secret = generateMfaSecret();
    const encrypted = encryptMfaSecret(secret);
    const validToken = authenticator.generate(secret);

    expect(verifyMfaToken(encrypted, validToken)).toBe(true);
  });

  it("rejects a token generated from a different secret", () => {
    const secret = generateMfaSecret();
    const otherSecret = generateMfaSecret();
    const encrypted = encryptMfaSecret(secret);
    const wrongToken = authenticator.generate(otherSecret);

    expect(verifyMfaToken(encrypted, wrongToken)).toBe(false);
  });

  it("rejects a malformed token", () => {
    const secret = generateMfaSecret();
    const encrypted = encryptMfaSecret(secret);
    expect(verifyMfaToken(encrypted, "000000")).toBe(false);
  });
});
