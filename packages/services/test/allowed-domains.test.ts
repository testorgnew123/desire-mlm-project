// Which email domains staff accounts may use. Pure: the setting is passed in, so
// nothing here reads process.env or touches a database. The wiring into
// createUser / updateUserRoles is tested in admin.test.ts.
import { describe, expect, it } from "vitest";
import { ROLE_NAMES } from "@desire/db";
import {
  EmailDomainNotAllowedError,
  EmailDomainsNotConfiguredError,
  assertEmailDomainAllowed,
  parseAllowedEmailDomains,
} from "../src/allowed-domains";

type Env = Record<string, string | undefined>;

const LIST: Env = { ALLOWED_EMAIL_DOMAINS: "example.org, example.net" };

describe("parseAllowedEmailDomains", () => {
  const ACCEPTED: [label: string, raw: string, domains: string[]][] = [
    ["one domain", "example.org", ["example.org"]],
    ["upper case", "Example.ORG", ["example.org"]],
    ["a leading @", "@example.org", ["example.org"]],
    ["commas, semicolons and spaces", " a.org , b.net;c.io ", ["a.org", "b.net", "c.io"]],
    ["duplicates", "example.org,EXAMPLE.org,@example.org", ["example.org"]],
    ["a punycode domain", "xn--mnchen-3ya.de", ["xn--mnchen-3ya.de"]],
    ["a subdomain on its own", "mail.example.org", ["mail.example.org"]],
    ["a label of 63 characters", `${"a".repeat(63)}.org`, [`${"a".repeat(63)}.org`]],
  ];
  it.each(ACCEPTED)("accepts %s", (_label, raw, domains) => {
    expect(parseAllowedEmailDomains(raw)).toEqual({ domains, problem: null });
  });

  const EMPTY: [label: string, raw: string | undefined][] = [
    ["unset", undefined],
    ["empty", ""],
    ["blank", "   "],
    ["only separators", ",;"],
  ];
  it.each(EMPTY)("treats a value that is %s as empty", (_label, raw) => {
    expect(parseAllowedEmailDomains(raw)).toEqual({ domains: [], problem: "is empty or not set" });
  });

  const MALFORMED = [
    "*.example.org",
    "example",
    "localhost",
    "1.2.3.4",
    "https://example.org",
    "a@example.org",
    "example.org/x",
    "example.org:443",
    "example.org.",
    "example..org",
    "-a.example.org",
    "münchen.de",
    `${"a".repeat(64)}.org`,
    `${"a.".repeat(130)}org`,
  ];
  it.each(MALFORMED)("refuses the whole list when it holds %s", (bad) => {
    const parsed = parseAllowedEmailDomains(`example.org, ${bad}`);
    expect(parsed.domains).toEqual([]);
    expect(parsed.problem).toContain(`contains "${bad}"`);
  });
});

describe("assertEmailDomainAllowed", () => {
  describe("SUPER_ADMIN (the client)", () => {
    const ENVS: [label: string, env: Env][] = [
      ["a list that does not include the domain", LIST],
      ["no setting at all", {}],
      ["an empty setting", { ALLOWED_EMAIL_DOMAINS: "" }],
      ["a malformed setting", { ALLOWED_EMAIL_DOMAINS: "*.example.org" }],
    ];
    it.each(ENVS)("may use any email, with %s", (_label, env) => {
      expect(() => assertEmailDomainAllowed("owner@gmail.com", "SUPER_ADMIN", env)).not.toThrow();
    });
  });

  describe.each(["ADMIN", "ASSOCIATE"] as const)("%s", (role) => {
    it.each(["a@example.org", "a@example.net", "A@Example.ORG"])("accepts %s", (email) => {
      expect(() => assertEmailDomainAllowed(email, role, LIST)).not.toThrow();
    });

    it.each([
      "a@gmail.com",
      "a@mail.example.org",
      "a@notexample.org",
      "a@example.org.evil.test",
      "example.org",
      "a@b@example.org",
      "@example.org",
      "a@",
      "a@example.org ",
    ])("refuses %s", (email) => {
      expect(() => assertEmailDomainAllowed(email, role, LIST)).toThrow(EmailDomainNotAllowedError);
    });

    it("names the role and the refused domain, and lists the allowed ones", () => {
      expect(() => assertEmailDomainAllowed("a@gmail.com", role, LIST)).toThrow(
        `${ROLE_NAMES[role]} accounts must use a company email address. "gmail.com" is not allowed; use an address at: example.org, example.net.`,
      );
    });

    const UNUSABLE: [label: string, env: Env, problem: RegExp][] = [
      ["unset", {}, /ALLOWED_EMAIL_DOMAINS is empty or not set/],
      ["empty", { ALLOWED_EMAIL_DOMAINS: " " }, /ALLOWED_EMAIL_DOMAINS is empty or not set/],
      ["malformed", { ALLOWED_EMAIL_DOMAINS: "example.org, *.example.net" }, /ALLOWED_EMAIL_DOMAINS contains "\*\.example\.net"/],
    ];
    it.each(UNUSABLE)("refuses every address when the setting is %s", (_label, env, problem) => {
      // Even an address on a domain the setting does name: a half-readable list is not trusted.
      const attempt = () => assertEmailDomainAllowed("a@example.org", role, env);
      expect(attempt).toThrow(EmailDomainsNotConfiguredError);
      expect(attempt).toThrow(problem);
      expect(attempt).toThrow(`${ROLE_NAMES[role]} accounts must use a company email address`);
    });
  });
});
