// Which email domains staff accounts may use.
//
// The list is server configuration, not data: ALLOWED_EMAIL_DOMAINS, set by whoever
// operates the deployment (Netlify > Environment variables, beside the SMTP
// settings). There is deliberately no screen and no table for it -- the Super Admin
// role goes to the client, and the client must not be able to widen the list.
//
// createUser and updateUserRoles (admin.ts) call assertEmailDomainAllowed:
//   - SUPER_ADMIN is exempt: any email works.
//   - Every other role, including any added later, needs an email on the list.
//     The match is exact: "mail.example.org" is not covered by "example.org";
//     list it too if it is wanted.
//   - A setting that is missing, empty or holds a malformed entry refuses every
//     non-exempt account instead of letting one through.
// Customers and leads are not accounts and never come through here.
import { ROLE_NAMES, type RoleCode } from "@desire/db";

const ENV_NAME = "ALLOWED_EMAIL_DOMAINS";

/** Roles whose email may be on any domain. Every other role is checked. */
const EXEMPT_ROLES: readonly RoleCode[] = ["SUPER_ADMIN"];

// ── Errors ─────────────────────────────────────────────────────────────

export class EmailDomainsNotConfiguredError extends Error {
  constructor(
    public readonly roleCode: RoleCode,
    problem: string,
  ) {
    super(
      `${ROLE_NAMES[roleCode]} accounts must use a company email address, but ${ENV_NAME} ${problem}. ` +
        "The system owner must correct that setting on the server first.",
    );
    this.name = "EmailDomainsNotConfiguredError";
  }
}

export class EmailDomainNotAllowedError extends Error {
  constructor(
    public readonly roleCode: RoleCode,
    public readonly domain: string,
    public readonly allowed: readonly string[],
  ) {
    super(
      `${ROLE_NAMES[roleCode]} accounts must use a company email address. ` +
        `"${domain}" is not allowed; use an address at: ${allowed.join(", ")}.`,
    );
    this.name = "EmailDomainNotAllowedError";
  }
}

// ── The list ───────────────────────────────────────────────────────────

// A plain ASCII domain: dot-separated labels of letters, digits and inner hyphens
// (63 characters at most each), at least two of them, ending in an alphabetic
// top-level label. No wildcard, scheme, port, path, "@", trailing dot or IP.
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const PLAIN_DOMAIN = new RegExp(`^(?:${LABEL}\\.)+[a-z]{2,63}$`);

function isPlainDomain(value: string): boolean {
  return value.length <= 253 && PLAIN_DOMAIN.test(value);
}

export interface ParsedAllowedDomains {
  domains: string[];
  /** Why the setting cannot be used, worded to follow "ALLOWED_EMAIL_DOMAINS"; null when it can. */
  problem: string | null;
}

/** Reads the setting's value: entries separated by commas, semicolons or spaces,
 *  case ignored, an optional leading "@". One bad entry spoils the whole list,
 *  because dropping it silently would hide a typo behind a half-working rule. */
export function parseAllowedEmailDomains(raw: string | undefined): ParsedAllowedDomains {
  const domains: string[] = [];
  for (const entry of (raw ?? "").split(/[\s,;]+/)) {
    if (entry === "") continue;
    const domain = entry.toLowerCase().replace(/^@/, "");
    if (!isPlainDomain(domain)) {
      return { domains: [], problem: `contains "${entry}", which is not a plain domain such as example.org` };
    }
    if (!domains.includes(domain)) domains.push(domain);
  }
  return domains.length > 0 ? { domains, problem: null } : { domains: [], problem: "is empty or not set" };
}

// ── The check ──────────────────────────────────────────────────────────

/** What follows the one "@", lower-cased. Null unless the address is a local part,
 *  exactly one "@" and something after it. */
function domainOf(email: string): string | null {
  const at = email.indexOf("@");
  if (at < 1 || email.indexOf("@", at + 1) !== -1) return null;
  return email.slice(at + 1).toLowerCase();
}

/** Throws unless `email` may be used for an account that holds `roleCode`. Pass an
 *  address already trimmed and lower-cased (admin.ts's normaliseEmail does that).
 *  The setting is read on every call, never cached. */
export function assertEmailDomainAllowed(
  email: string,
  roleCode: RoleCode,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (EXEMPT_ROLES.includes(roleCode)) return;

  const { domains, problem } = parseAllowedEmailDomains(env[ENV_NAME]);
  if (problem) throw new EmailDomainsNotConfiguredError(roleCode, problem);

  const domain = domainOf(email);
  if (domain === null || !domains.includes(domain)) {
    throw new EmailDomainNotAllowedError(roleCode, domain ?? email, domains);
  }
}
