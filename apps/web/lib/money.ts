// Money and area formatting -- split out of lib/format.ts because both need
// Prisma.Decimal (@desire/db), which must never reach a client bundle (it
// pulls in pg's net/tls dependencies). Server Components and Server Actions
// only; a client component that needs these should be handed an already
// formatted string as a prop instead of importing this module directly.
//
// Formatted straight off the Decimal string, never through Number() -- the
// same "no float arithmetic in a money path" rule board's own formatArea
// already followed (docs/12-NFR.md).
import { Prisma } from "@desire/db";
import { groupIndian } from "./format";

function toFixed2(value: Prisma.Decimal | string): Prisma.Decimal {
  return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
}

function groupSigned(fixed: string): string {
  const negative = fixed.startsWith("-");
  const unsigned = negative ? fixed.slice(1) : fixed;
  const dot = unsigned.indexOf(".");
  const intPart = dot === -1 ? unsigned : unsigned.slice(0, dot);
  const fracPart = dot === -1 ? "" : unsigned.slice(dot);
  return `${negative ? "-" : ""}${groupIndian(intPart)}${fracPart}`;
}

/** Rupee symbol, Indian digit grouping, always exactly 2 decimal places --
 *  never truncated or rounded away. This is the figure a customer or
 *  associate reconciles against a receipt, so it always carries the paise. */
export function formatMoney(value: Prisma.Decimal | string): string {
  return `₹${groupSigned(toFixed2(value).toFixed(2))}`;
}

const ONE_LAKH = new Prisma.Decimal(100_000);
const ONE_CRORE = new Prisma.Decimal(10_000_000);

/** Compact form for dashboard tiles ("₹12.30 L", "₹1.25 Cr"). Callers
 *  MUST also carry the exact figure -- e.g. via formatMoney(value) in a
 *  `title` attribute -- since this form is lossy by design. */
export function formatMoneyCompact(value: Prisma.Decimal | string): string {
  const decimal = toFixed2(value);
  const abs = decimal.abs();
  const sign = decimal.isNegative() ? "-" : "";
  if (abs.greaterThanOrEqualTo(ONE_CRORE)) {
    return `${sign}₹${abs.dividedBy(ONE_CRORE).toFixed(2)} Cr`;
  }
  if (abs.greaterThanOrEqualTo(ONE_LAKH)) {
    return `${sign}₹${abs.dividedBy(ONE_LAKH).toFixed(2)} L`;
  }
  return formatMoney(decimal);
}

export type AreaKind = "carpet" | "builtUp" | "saleable";

/** Glossary terms (docs/19-GLOSSARY.md): carpet, built-up, saleable (a.k.a.
 *  super built-up -- the figure price-per-sqft is quoted on). */
const AREA_LABELS: Record<AreaKind, string> = {
  carpet: "carpet",
  builtUp: "built-up",
  saleable: "saleable",
};

/** Every area is labelled with which area it is -- a bare "1,250 sq ft" is
 *  the most expensive mistake in this domain: carpet quoted against a
 *  saleable rate misprices a unit by roughly 35% (docs/19-GLOSSARY.md). */
export function formatArea(value: Prisma.Decimal | string, kind: AreaKind): string {
  return `${groupSigned(toFixed2(value).toFixed(2))} sq ft (${AREA_LABELS[kind]})`;
}
