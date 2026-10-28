// Real SMTP sending -- the mechanism has existed as unused env vars in
// .env.example since Phase 0 (SMTP_HOST/PORT/USER/PASSWORD, MAIL_FROM) with
// no code behind them. Unlike WhatsApp Business API and DLT-registered SMS
// (structurally paid at any volume, PROGRESS.md decision log 2026-09-13),
// plain SMTP has real free options at this project's scale (a free-tier
// transactional mailer, or the client's own existing email hosting), so
// this is built for real with placeholder/unset credentials -- same
// pattern as TaxRate, not the same as WhatsApp/SMS.
import nodemailer, { type Transporter } from "nodemailer";

export class EmailConfigError extends Error {}

let cachedTransporter: Transporter | null = null;

/** True when the settings every send needs are present. Cheap, reads no network,
 *  so a caller can skip all of its own work when mail cannot go out anyway. */
export function isMailConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_PORT && process.env.MAIL_FROM);
}

/** Which mail settings are set, never their values (a password or an address has
 *  no business on a screen). SMTP_USER and SMTP_PASSWORD are optional: a relay on a
 *  private network may take mail without a login. */
export function mailSettingsStatus(): Array<{ name: string; set: boolean; required: boolean; note: string }> {
  const set = (name: string) => Boolean(process.env[name]?.trim());
  return [
    { name: "SMTP_HOST", set: set("SMTP_HOST"), required: true, note: "The mail server, e.g. smtp.example.com" },
    { name: "SMTP_PORT", set: set("SMTP_PORT"), required: true, note: "587 (STARTTLS) or 465 (SSL)" },
    { name: "SMTP_USER", set: set("SMTP_USER"), required: false, note: "The login, if the server asks for one" },
    { name: "SMTP_PASSWORD", set: set("SMTP_PASSWORD"), required: false, note: "Its password or app key" },
    { name: "MAIL_FROM", set: set("MAIL_FROM"), required: true, note: "The From address, one the server lets you send as" },
    { name: "APP_BASE_URL", set: set("APP_BASE_URL"), required: true, note: "This site's public address: password-reset links and links in mail need it" },
  ];
}

/** What went wrong, in words a person can act on, from the error nodemailer
 *  raised. Only the error's code and the server's first reply line are used, so no
 *  setting or secret can leak into the text. */
export function describeMailError(error: unknown): string {
  if (error instanceof EmailConfigError) return error.message;
  const err = error as { code?: string; responseCode?: number; response?: string } | null;
  const reply = typeof err?.response === "string" ? err.response.split(/\r?\n/)[0]!.slice(0, 160) : null;
  switch (err?.code) {
    case "EAUTH":
      return `The mail server refused the login (SMTP_USER / SMTP_PASSWORD).${reply ? ` It said: ${reply}` : ""}`;
    case "ECONNECTION":
    case "ESOCKET":
    case "ECONNREFUSED":
      return "Could not connect to the mail server. Check SMTP_HOST and SMTP_PORT, and that the server allows connections from here.";
    case "ETIMEDOUT":
    case "ETIMEOUT":
      return "The mail server did not answer in time. Check SMTP_HOST and SMTP_PORT.";
    case "EDNS":
    case "ENOTFOUND":
      return "The mail server's name (SMTP_HOST) could not be found.";
    case "EENVELOPE":
      return `The server refused the sender or the recipient.${reply ? ` It said: ${reply}` : " Check MAIL_FROM and the address."}`;
    default:
      return `The mail server did not accept the message.${reply ? ` It said: ${reply}` : ""}`;
  }
}

function getTransporter(): Transporter {
  if (cachedTransporter) return cachedTransporter;

  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT;
  if (!host || !port) {
    throw new EmailConfigError("SMTP_HOST/SMTP_PORT are not set -- no email provider configured yet.");
  }

  cachedTransporter = nodemailer.createTransport({
    host,
    port: Number(port),
    secure: Number(port) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
    // nodemailer's defaults wait two minutes to connect and thirty seconds for the
    // greeting. A mail server that accepts the connection and then says nothing
    // (seen with a localhost sink that resolved to the wrong address family) would
    // hold every request that sends mail open that long -- longer than a Netlify
    // function lives. Short and explicit instead.
    connectionTimeout: 5_000,
    greetingTimeout: 5_000,
    socketTimeout: 10_000,
  });
  return cachedTransporter;
}

export interface SendEmailParams {
  to: string;
  subject: string;
  text: string;
  attachment?: { filename: string; content: Buffer | string; contentType: string };
}

export async function sendEmail(params: SendEmailParams): Promise<void> {
  const transporter = getTransporter();
  const from = process.env.MAIL_FROM;
  if (!from) throw new EmailConfigError("MAIL_FROM is not set.");

  await transporter.sendMail({
    from,
    to: params.to,
    subject: params.subject,
    text: params.text,
    attachments: params.attachment ? [params.attachment] : undefined,
  });
}
