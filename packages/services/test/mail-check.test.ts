// The settings check and the test email behind the Admin > Email screen: what it
// says is wrong, and that it never prints a setting's value.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as EmailModule from "../src/email";
import { sendTestEmail } from "../src/account-mail";
import { EmailConfigError, describeMailError, isMailConfigured, mailSettingsStatus } from "../src/email";

const mail = vi.hoisted(() => ({
  next: null as unknown,
  sent: [] as { to: string; subject: string; text: string }[],
}));
vi.mock("../src/email", async (importOriginal) => {
  const original = await importOriginal<typeof EmailModule>();
  return {
    ...original,
    sendEmail: async (params: { to: string; subject: string; text: string }) => {
      if (mail.next) throw mail.next;
      mail.sent.push(params);
    },
  };
});

const NAMES = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD", "MAIL_FROM", "APP_BASE_URL"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));
  for (const name of NAMES) delete process.env[name];
  mail.next = null;
  mail.sent.length = 0;
});
afterEach(() => {
  for (const name of NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

function configure() {
  process.env.SMTP_HOST = "smtp.secret-host.test";
  process.env.SMTP_PORT = "587";
  process.env.SMTP_USER = "mailer-user";
  process.env.SMTP_PASSWORD = "hunter2-very-secret";
  process.env.MAIL_FROM = "noreply@desire.test";
  process.env.APP_BASE_URL = "https://desire.test";
}

describe("isMailConfigured", () => {
  it("needs host, port and sender, and nothing else", () => {
    expect(isMailConfigured()).toBe(false);
    process.env.SMTP_HOST = "h";
    process.env.SMTP_PORT = "587";
    expect(isMailConfigured()).toBe(false);
    process.env.MAIL_FROM = "a@b.test";
    expect(isMailConfigured()).toBe(true);
  });
});

describe("mailSettingsStatus", () => {
  it("says which are set and which are required, and never carries a value", () => {
    configure();
    const status = mailSettingsStatus();
    expect(status.map((s) => s.name)).toEqual([...NAMES]);
    expect(status.every((s) => s.set)).toBe(true);
    expect(JSON.stringify(status)).not.toContain("hunter2");
    expect(JSON.stringify(status)).not.toContain("secret-host");
    expect(status.find((s) => s.name === "SMTP_USER")?.required).toBe(false);
    expect(status.find((s) => s.name === "APP_BASE_URL")?.required).toBe(true);
  });

  it("treats a blank value as not set", () => {
    process.env.SMTP_HOST = "   ";
    expect(mailSettingsStatus().find((s) => s.name === "SMTP_HOST")?.set).toBe(false);
  });
});

describe("describeMailError", () => {
  it.each([
    [{ code: "EAUTH", response: "535 5.7.8 Username and Password not accepted" }, /refused the login.*535 5\.7\.8/],
    [{ code: "ECONNECTION" }, /Could not connect/],
    [{ code: "ETIMEDOUT" }, /did not answer in time/],
    [{ code: "EDNS" }, /could not be found/],
    [{ code: "EENVELOPE", response: "550 sender not allowed" }, /refused the sender.*550 sender not allowed/],
    [{ code: "EWHATEVER", response: "554 rejected\r\nsecond line" }, /did not accept the message\. It said: 554 rejected$/],
  ])("%j", (error, pattern) => {
    expect(describeMailError(error)).toMatch(pattern);
  });

  it("explains missing settings and a plain error without inventing detail", () => {
    expect(describeMailError(new EmailConfigError("SMTP_HOST/SMTP_PORT are not set -- no email provider configured yet."))).toMatch(/not set/);
    expect(describeMailError(new Error("boom"))).toBe("The mail server did not accept the message.");
  });
});

describe("sendTestEmail", () => {
  it("names the missing settings instead of trying", async () => {
    process.env.SMTP_HOST = "h";
    const result = await sendTestEmail({ to: "a@b.test", requestedBy: "Admin" });
    expect(result.sent).toBe(false);
    expect(result.message).toMatch(/SMTP_PORT, MAIL_FROM, APP_BASE_URL are not set/);
    expect(mail.sent).toHaveLength(0);
  });

  it("refuses an address that is not one", async () => {
    configure();
    const result = await sendTestEmail({ to: "not-an-address", requestedBy: "Admin" });
    expect(result.sent).toBe(false);
    expect(result.message).toMatch(/not a valid email address/);
  });

  it("sends one message and says who asked", async () => {
    configure();
    const result = await sendTestEmail({ to: " Person@Example.test ", requestedBy: "Asha Admin" });
    expect(result.sent).toBe(true);
    expect(result.message).toContain("person@example.test");
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.text).toContain("Asha Admin");
  });

  it("reports why the server said no, with no setting's value in it", async () => {
    configure();
    mail.next = Object.assign(new Error("Invalid login"), { code: "EAUTH", response: "535 bad credentials" });
    const result = await sendTestEmail({ to: "a@b.test", requestedBy: "Admin" });
    expect(result.sent).toBe(false);
    expect(result.message).toMatch(/refused the login/);
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(JSON.stringify(result)).not.toContain("secret-host");
  });
});
