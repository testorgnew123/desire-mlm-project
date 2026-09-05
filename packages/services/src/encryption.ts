// Field-level encryption for PAN, Aadhaar, and bank account numbers -- see
// docs/10-SECURITY.md. This is IN ADDITION to Neon's at-rest volume
// encryption, so a database dump alone is not a KYC breach.
//
// AES-256-GCM: authenticated encryption, so tampering is detected (not just
// confidentiality). The key is versioned (PII_ENCRYPTION_KEY_ID) so rotation
// keeps old keys available for decrypt without needing to re-encrypt
// everything atomically -- see .env.example.
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH_BYTES = 12; // 96-bit IV is the GCM-recommended size
const AUTH_TAG_LENGTH_BYTES = 16;

export class EncryptionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncryptionConfigError";
  }
}

export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecryptionError";
  }
}

function loadKey(): Buffer {
  const b64 = process.env.PII_ENCRYPTION_KEY;
  if (!b64) {
    throw new EncryptionConfigError("PII_ENCRYPTION_KEY is not set.");
  }
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) {
    throw new EncryptionConfigError(
      `PII_ENCRYPTION_KEY must decode to exactly 32 bytes (AES-256); got ${key.length}.`,
    );
  }
  return key;
}

/** Stored format: keyId:iv:authTag:ciphertext, each base64. The key id travels
 *  with the ciphertext so a rotated key can still decrypt old rows -- see
 *  .env.example PII_ENCRYPTION_KEY_ID. */
export function encryptField(plaintext: string): string {
  const key = loadKey();
  const keyId = process.env.PII_ENCRYPTION_KEY_ID ?? "v1";
  const iv = randomBytes(IV_LENGTH_BYTES);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [keyId, iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(
    ":",
  );
}

export function decryptField(stored: string): string {
  const parts = stored.split(":");
  if (parts.length !== 4) {
    throw new DecryptionError("Malformed encrypted field: expected 4 colon-separated parts.");
  }
  const [keyId, ivB64, authTagB64, ciphertextB64] = parts as [string, string, string, string];

  // Only one key is active today. When rotation is implemented, this is
  // where a keyId -> key lookup replaces the single loadKey() call --
  // deliberately not built speculatively before there is a second key.
  const expectedKeyId = process.env.PII_ENCRYPTION_KEY_ID ?? "v1";
  if (keyId !== expectedKeyId) {
    throw new DecryptionError(
      `Encrypted with key "${keyId}" but only "${expectedKeyId}" is configured. Key rotation needed.`,
    );
  }

  const key = loadKey();
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");

  if (authTag.length !== AUTH_TAG_LENGTH_BYTES) {
    throw new DecryptionError("Malformed encrypted field: invalid auth tag length.");
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  try {
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
  } catch {
    // GCM auth-tag mismatch throws a generic OpenSSL error -- normalize it so
    // callers see a clear signal rather than a cryptic native error message.
    throw new DecryptionError("Decryption failed: ciphertext or auth tag is invalid or tampered.");
  }
}

/** Last 4 characters for display without decrypting -- e.g. PAN/Aadhaar
 *  masking in the UI. Operates on the PLAINTEXT, called once at write time
 *  and stored alongside the ciphertext (see Associate.panLast4 in the
 *  schema) -- never derived from ciphertext, which would leak nothing useful
 *  anyway. */
export function last4(plaintext: string): string {
  return plaintext.slice(-4);
}
