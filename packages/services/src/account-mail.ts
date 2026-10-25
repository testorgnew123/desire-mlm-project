// The three emails the account flows send: credentials for a new account,
// credentials after an admin reset, and the self-service reset link.
//
// Sending never throws. An account has already been created (or a password
// already changed) by the time mail goes out, and a mail server that is down or
// not configured must not turn that into an error: the caller gets an outcome and
// decides what to tell the person (admin.ts shows the admin the temporary
// password once when the mail did not go).
import { EmailConfigError, sendEmail } from "./email";

export interface MailOutcome {
  sent: boolean;
  /** Why it was not sent, in words the admin can act on. Null when it was. */
  note: string | null;
}

/** The app's own public address, for links and the sign-in line in mail. Read
 *  at call time and never guessed from a request header (a forged Host header
 *  would put an attacker's address into a password-reset mail). Null when unset. */
export function appBaseUrl(): string | null {
  const raw = process.env.APP_BASE_URL?.trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

/** The longest an account action waits for the mail server. The account or the
 *  new password already exists by then, and the request must still come back well
 *  inside a serverless function's lifetime; a mail that is merely slow may still
 *  go out after the caller has been told it did not. */
export const MAIL_DEADLINE_MS = 8_000;

class MailDeadlineError extends Error {}

async function deliver(
  params: { to: string; subject: string; text: string },
  deadlineMs: number = MAIL_DEADLINE_MS,
): Promise<MailOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      sendEmail(params),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new MailDeadlineError()), deadlineMs);
      }),
    ]);
    return { sent: true, note: null };
  } catch (error) {
    if (error instanceof EmailConfigError) {
      return { sent: false, note: "Email is not set up on this server (SMTP settings are missing)." };
    }
    if (error instanceof MailDeadlineError) {
      return { sent: false, note: "The email server did not answer in time." };
    }
    return { sent: false, note: "The email server did not accept the message." };
  } finally {
    clearTimeout(timer);
  }
}

export interface CredentialsMail {
  to: string;
  name: string;
  /** What they type into the email box on the sign-in page. */
  loginId: string;
  temporaryPassword: string;
  associateCode?: string | null;
  kind: "created" | "reset";
}

export function credentialsMailText(mail: CredentialsMail, baseUrl: string | null): string {
  const lead =
    mail.kind === "created"
      ? "An account has been created for you on Desire."
      : "Your Desire password has been reset by an administrator.";
  return [
    `Hello ${mail.name},`,
    "",
    lead,
    "",
    ...(baseUrl ? [`Sign in: ${baseUrl}/login`] : []),
    `Login ID: ${mail.loginId}`,
    `Temporary password: ${mail.temporaryPassword}`,
    ...(mail.associateCode ? [`Associate code: ${mail.associateCode}`] : []),
    "",
    "You will be asked to choose your own password the first time you sign in.",
    "If you were not expecting this email, you can ignore it.",
  ].join("\n");
}

export function sendCredentialsEmail(mail: CredentialsMail, deadlineMs?: number): Promise<MailOutcome> {
  return deliver(
    {
      to: mail.to,
      subject: mail.kind === "created" ? "Your Desire account" : "Your Desire password was reset",
      text: credentialsMailText(mail, appBaseUrl()),
    },
    deadlineMs,
  );
}

export function resetLinkMailText(params: { name: string; link: string; minutes: number }): string {
  return [
    `Hello ${params.name},`,
    "",
    "Someone asked to reset the password for your Desire account. To choose a new one, open:",
    "",
    params.link,
    "",
    `The link works once and expires in ${params.minutes} minutes.`,
    "If you did not ask for this, ignore this email and your password stays as it is.",
  ].join("\n");
}

export function sendPasswordResetLink(
  params: { to: string; name: string; link: string; minutes: number },
  deadlineMs?: number,
): Promise<MailOutcome> {
  return deliver(
    {
      to: params.to,
      subject: "Reset your Desire password",
      text: resetLinkMailText({ name: params.name, link: params.link, minutes: params.minutes }),
    },
    deadlineMs,
  );
}
