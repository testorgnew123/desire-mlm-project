// Customers. Nothing in the product created one before: a booking needs a
// customerId and customer rows came only from tests, so a booking could not be
// started through any screen. This is the way in -- name, phone and optionally
// an email, captured by the associate at the moment of booking. KYC (PAN,
// Aadhaar, address) is not collected here; it can be added to the row later.
//
// Always creates a NEW row. Matching on phone would let one associate attach a
// booking to a customer record another associate made, and see nothing, but
// still tie the two together -- so every booking gets its own customer.
import type { Customer, Prisma, PrismaClient } from "@desire/db";
import { writeAuditLog, type AuditContext } from "./audit";
import { assertPermission, ForbiddenError } from "./rbac";

const CREATE_PERMISSION = "booking.create";
const MAX_NAME_LENGTH = 120;

export class InvalidCustomerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCustomerError";
  }
}

/** Stored the same way the lead module stores phones (+91 for a bare 10-digit
 *  Indian mobile), but it REFUSES what it cannot make sense of instead of
 *  guessing -- a booking is not the place for a number nobody can call. Kept here
 *  rather than imported from leads.ts, which belongs to a switched-off feature. */
export function normaliseCustomerPhone(raw: string): string {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10 && /^[6-9]/.test(digits)) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91") && /^[6-9]/.test(digits.slice(2))) return `+${digits}`;
  if (trimmed.startsWith("+") && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  throw new InvalidCustomerError("Enter a valid mobile number, such as 98765 43210 or +971 50 123 4567.");
}

export interface CustomerInput {
  name: string;
  phone: string;
  email?: string | null;
}

/** Validates and tidies what a form sent. Pure, so it can run before any hold is
 *  taken -- bookPlot checks the customer first so a typo never costs a plot. */
export function parseCustomerInput(input: CustomerInput): { name: string; phone: string; email: string | null } {
  const name = input.name.trim().replace(/\s+/g, " ");
  if (name === "") throw new InvalidCustomerError("Enter the customer's name.");
  if (name.length > MAX_NAME_LENGTH) throw new InvalidCustomerError(`The name is too long (at most ${MAX_NAME_LENGTH} characters).`);

  const phone = normaliseCustomerPhone(input.phone);

  const rawEmail = (input.email ?? "").trim().toLowerCase();
  if (rawEmail !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
    throw new InvalidCustomerError(`"${input.email}" is not a valid email address.`);
  }
  return { name, phone, email: rawEmail === "" ? null : rawEmail };
}

export async function createCustomer(
  db: PrismaClient,
  params: CustomerInput & { audit: AuditContext },
): Promise<Customer> {
  const actorId = params.audit.actorId;
  if (!actorId) throw new ForbiddenError("Creating a customer requires a user actor, not a system actor.");
  const parsed = parseCustomerInput(params);

  return db.$transaction(async (tx: Prisma.TransactionClient) => {
    await assertPermission(tx, actorId, CREATE_PERMISSION);

    const customer = await tx.customer.create({
      data: { orgId: params.audit.orgId, name: parsed.name, phone: parsed.phone, email: parsed.email },
    });
    await writeAuditLog(tx, params.audit, {
      action: "CREATE",
      entity: "Customer",
      entityId: customer.id,
      after: { name: customer.name, phone: customer.phone, email: customer.email },
    });
    return customer;
  });
}
