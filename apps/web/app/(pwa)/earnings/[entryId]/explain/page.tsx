import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Prisma, getPrismaClient } from "@desire/db";
import { CommissionEntryNotFoundError, explainEntry } from "@desire/services/commission";
import { ForbiddenError } from "@desire/services/rbac";
import { requireSession } from "@/lib/session";
import { formatMoney, formatArea } from "@/lib/money";
import { formatDateTime } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = {
  title: "Explain this number — Desire",
};

interface Snapshot {
  gradeCode: string;
  gradeRank: number;
  rateType: "PCT_OF_BASE" | "PER_SQFT" | "FLAT";
  rateValue: string;
  sellerCommission: string;
  levelPct?: string;
  uplineChain: Array<{ level: number; associateId: string; code: string; gradeCode: string }>;
  schemeVersion: number;
  compressionMode: "NONE" | "ROLL_UP";
  computedAt: string;
}

/** "Explain this number" -- docs/08-SCREENS.md §2, one of the three screens
 *  that carry the product. Every figure comes straight from
 *  CommissionEntry.snapshot (frozen at accrual time), never recomputed --
 *  it renders identically years later regardless of what changed since. */
export default async function ExplainEntryPage({
  params,
}: {
  params: Promise<{ entryId: string }>;
}) {
  const { entryId } = await params;
  const session = await requireSession();
  const db = getPrismaClient();

  let entry;
  try {
    entry = await explainEntry(db, {
      entryId,
      audit: { orgId: session.user.orgId, actorId: session.user.id, actorLabel: session.user.name },
    });
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof CommissionEntryNotFoundError) notFound();
    throw error;
  }

  const snapshot = entry.snapshot as unknown as Snapshot;

  const booking = await db.booking.findUnique({
    where: { id: entry.bookingId },
    select: {
      sellingAssociateId: true,
      saleableAreaAtBooking: true,
      customer: { select: { name: true } },
      unit: { select: { unitNumber: true } },
    },
  });

  const [sellingAssociate, releases] = await Promise.all([
    booking
      ? db.associate.findUnique({
          where: { id: booking.sellingAssociateId },
          select: {
            code: true,
            user: { select: { name: true } },
            grades: {
              where: { validTo: null },
              select: { grade: { select: { code: true, name: true } } },
            },
          },
        })
      : null,
    db.commissionRelease.findMany({
      where: { entryId, reversedAt: null },
      select: { amount: true },
    }),
  ]);

  const releasedTotal = releases.reduce(
    (sum: Prisma.Decimal, release) => sum.plus(release.amount),
    new Prisma.Decimal(0),
  );

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <p className="text-2xl font-semibold tabular-nums">{formatMoney(entry.grossAmount)}</p>
        <p className="text-sm text-muted-foreground">
          {entry.role === "SELF" ? "Self" : `Override, Level ${entry.level}`}
          {booking ? ` — ${booking.customer.name}, Unit ${booking.unit.unitNumber}` : ""}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Derivation</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col divide-y divide-border text-sm">
          <Row label="Commissionable value" value={formatMoney(entry.baseAmount)} />
          {booking ? (
            <Row label="Saleable area" value={formatArea(booking.saleableAreaAtBooking, "saleable")} />
          ) : null}
          {sellingAssociate ? (
            <Row
              label="Seller"
              value={`${sellingAssociate.user.name} (${sellingAssociate.code})${
                sellingAssociate.grades[0] ? `, Grade ${sellingAssociate.grades[0].grade.code}` : ""
              }`}
            />
          ) : null}
          <Row
            label="Seller rate"
            value={`${snapshot.rateValue}${snapshot.rateType === "PCT_OF_BASE" ? "% of base" : snapshot.rateType === "PER_SQFT" ? " per sq ft" : " flat"} → ${formatMoney(snapshot.sellerCommission)}`}
          />
          {entry.role === "OVERRIDE" ? (
            <>
              <Row label="Your level" value={`L${entry.level}`} />
              <Row
                label="Level rate"
                value={`${snapshot.levelPct}% of seller commission → ${formatMoney(entry.grossAmount)}`}
              />
            </>
          ) : null}
          <Row label="Your grade at computation" value={`${snapshot.gradeCode} (rank ${snapshot.gradeRank})`} />
          <Row label="Scheme" value={`version ${snapshot.schemeVersion} · ${snapshot.compressionMode} compression`} />
          <Row label="Computed at" value={formatDateTime(snapshot.computedAt)} />
          <Row
            label="Release"
            value={`${entry.status} — ${formatMoney(releasedTotal)} released of ${formatMoney(entry.grossAmount)}`}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 first:pt-0 last:pb-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}
