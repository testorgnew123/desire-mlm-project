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
