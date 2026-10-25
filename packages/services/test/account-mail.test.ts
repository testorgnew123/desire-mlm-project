import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as EmailModule from "../src/email";
import { EmailConfigError } from "../src/email";
import {
  appBaseUrl,
  credentialsMailText,
  resetLinkMailText,
  sendCredentialsEmail,
  sendPasswordResetLink,
} from "../src/account-mail";

const mail = vi.hoisted(() => ({
  mode: "ok" as "ok" | "hang" | "config" | "refuse",
  sent: [] as { to: string; subject: string }[],
}));
vi.mock("../src/email", async (importOriginal) => {
  const original = await importOriginal<typeof EmailModule>();
  return {
    ...original,
    sendEmail: async (params: { to: string; subject: string; text: string }) => {
      if (mail.mode === "hang") return new Promise<void>(() => undefined);
      if (mail.mode === "config") throw new original.EmailConfigError("no smtp");
      if (mail.mode === "refuse") throw new Error("550 mailbox unavailable");
      mail.sent.push({ to: params.to, subject: params.subject });
    },
  };
});

describe("credentialsMailText", () => {
  const base = { to: "a@x.test", name: "Asha", loginId: "a@x.test", temporaryPassword: "Tmp-pass-123" };

  it("names the login ID, the temporary password and the forced change", () => {
    const text = credentialsMailText({ ...base, kind: "created" }, "https://app.test");
    expect(text).toContain("Hello Asha,");
    expect(text).toContain("An account has been created for you");
    expect(text).toContain("Login ID: a@x.test");
    expect(text).toContain("Temporary password: Tmp-pass-123");
    expect(text).toContain("Sign in: https://app.test/login");
    expect(text).toContain("choose your own password");
  });

  it("says the password was reset, not that an account was created, for a reset", () => {
    const text = credentialsMailText({ ...base, kind: "reset" }, "https://app.test");
    expect(text).toContain("has been reset by an administrator");
    expect(text).not.toContain("An account has been created");
  });

  it("leaves out the sign-in line when the app's address is not configured", () => {
    expect(credentialsMailText({ ...base, kind: "created" }, null)).not.toContain("Sign in:");
  });

  it("adds the associate code only when there is one", () => {
    expect(credentialsMailText({ ...base, kind: "created", associateCode: "A-0007" }, null)).toContain("Associate code: A-0007");
    expect(credentialsMailText({ ...base, kind: "created", associateCode: null }, null)).not.toContain("Associate code");
  });
});

describe("resetLinkMailText", () => {
  it("carries the link, the lifetime and a line for someone who did not ask", () => {
    const text = resetLinkMailText({ name: "Asha", link: "https://app.test/login/reset?token=abc", minutes: 30 });
    expect(text).toContain("https://app.test/login/reset?token=abc");
    expect(text).toContain("expires in 30 minutes");
    expect(text).toContain("If you did not ask for this");
  });
});

describe("appBaseUrl", () => {
  const original = process.env.APP_BASE_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = original;
  });

  it("drops trailing slashes and whitespace", () => {
    process.env.APP_BASE_URL = " https://crm.example.in// ";
    expect(appBaseUrl()).toBe("https://crm.example.in");
  });

  it("is null when unset or blank, never a guess", () => {
    delete process.env.APP_BASE_URL;
    expect(appBaseUrl()).toBeNull();
    process.env.APP_BASE_URL = "   ";
    expect(appBaseUrl()).toBeNull();
  });
});

describe("sending", () => {
  const credentials = { to: "a@x.test", name: "Asha", loginId: "a@x.test", temporaryPassword: "pw", kind: "created" as const };

  beforeEach(() => {
    mail.mode = "ok";
    mail.sent.length = 0;
  });

  it("reports a sent message", async () => {
    expect(await sendCredentialsEmail(credentials)).toEqual({ sent: true, note: null });
    expect(mail.sent).toEqual([{ to: "a@x.test", subject: "Your Desire account" }]);
  });

  it("never throws: missing SMTP settings, a refusal and a silent server each come back as a note", async () => {
    mail.mode = "config";
    expect(await sendCredentialsEmail(credentials)).toMatchObject({ sent: false, note: expect.stringMatching(/not set up/) });
    mail.mode = "refuse";
    expect(await sendCredentialsEmail(credentials)).toMatchObject({ sent: false, note: expect.stringMatching(/did not accept/) });
    expect(new EmailConfigError("x")).toBeInstanceOf(Error);
  });

  it("stops waiting for a mail server that never answers, within the deadline it is given", async () => {
    mail.mode = "hang";
    const started = Date.now();
    const outcome = await sendCredentialsEmail(credentials, 60);
    expect(outcome).toEqual({ sent: false, note: "The email server did not answer in time." });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("applies the same deadline to the reset link", async () => {
    mail.mode = "hang";
    const outcome = await sendPasswordResetLink({ to: "a@x.test", name: "Asha", link: "https://app.test/x", minutes: 30 }, 60);
    expect(outcome.sent).toBe(false);
    expect(outcome.note).toMatch(/in time/);
  });
});
