// TOTP MFA, split out of auth.ts on purpose -- the same reasoning that
// already put password.ts in its own module, applied to a second dependency.
//
// auth.ts holds validateSession, which runs on EVERY authenticated request.
// While these three functions lived there, `otplib` was imported at module
// scope on that hot path, so every request (and every serverless cold start)
// loaded a library used only during MFA enrolment and the MFA challenge --
// two screens most sessions never touch. auth.ts's own header already states
// the rule: "validateSession is on the hot path for every request, so this
// file must stay free of native dependencies". otplib is not native, but the
// cold-start cost is the same kind of tax, so it moves out for the same reason.
//
// Kept synchronous deliberately: a lazy `await import()` inside each function
// would have made all three async and rippled through every caller for no
// gain over simply moving the import off the hot path.
//
// mfaSecret is stored encrypted (via the same AES-256-GCM used for KYC
// fields) even though the schema does not split it into separate
// ciphertext/last4 columns the way PAN/Aadhaar do -- it is a single opaque
// String column, so the "keyId:iv:tag:ciphertext" format from encryptField
// fits it directly with no schema change. A TOTP secret is as sensitive as a
// password; storing it in the clear next to an argon2id hash would be an
// inconsistent security posture for no benefit.
import { authenticator } from "otplib";
import { decryptField, encryptField } from "./encryption";

export function generateMfaSecret(): string {
  return authenticator.generateSecret();
}

export function buildMfaEnrollmentUri(secret: string, accountLabel: string, issuer: string): string {
  return authenticator.keyuri(accountLabel, issuer, secret);
}

export function verifyMfaToken(encryptedSecret: string, token: string): boolean {
  const secret = decryptField(encryptedSecret);
  return authenticator.verify({ token, secret });
}

export function encryptMfaSecret(plainSecret: string): string {
  return encryptField(plainSecret);
}
