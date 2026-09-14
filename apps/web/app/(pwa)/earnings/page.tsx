import type { Metadata } from "next";
import Link from "next/link";
import { getPrismaClient } from "@desire/db";
import { getEarnings } from "@desire/services/commission";
import { requireSession } from "@/lib/session";
import { formatMoney } from "@/lib/money";
import { formatDate } from "@/lib/format";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = {
  title: "Earnings — Desire",
};

/** Earnings tab (docs/08-SCREENS.md): accrued/payable/paid, blocked-by-
 *  collections, statements, grade progress. "Statements" -- no PayoutBatch/
 *  PDF exists yet (that's Phase 4) -- is honestly the associate's own
 *  CommissionEntry rows, each linking to the real "explain this number"
 *  drill-down built in this same slice. "Grade progress" is the real grade
 *  ladder with the associate's current rung highlighted -- auto-
 *  qualification thresholds are still PLACEHOLDER (null) for every seeded
 *  grade, so a fabricated percentage would be dishonest; position in the
 *  ladder is the real thing available today. */
export default async function EarningsPage() {
  const session = await requireSession();
  const db = getPrismaClient();

  const associate = await db.associate.findUnique({
    where: { userId: session.user.id },
    select: { id: true },
  });

  if (!associate) {
    return (
      <div className="p-4">
        <p className="text-sm text-muted-foreground">No associate record found.</p>
      </div>
    );
  }

  const [earnings, entries, grades, currentGrade] = await Promise.all([
    getEarnings(db, {
      associateId: associate.id,
      audit: { orgId: session.user.orgId, actorId: session.user.id, actorLabel: session.user.name },
    }),
    db.commissionEntry.findMany({
      where: { beneficiaryAssociateId: associate.id, status: { not: "REVERSED" } },
      orderBy: { accruedAt: "desc" },
      take: 20,
      select: { id: true, grossAmount: true, status: true, role: true, level: true, accruedAt: true },
    }),
    db.grade.findMany({ where: { orgId: session.user.orgId }, orderBy: { rank: "asc" } }),
    db.associateGrade.findFirst({
      where: { associateId: associate.id, validTo: null },
      select: { gradeId: true },
    }),
  ]);

  return (
    <div className="flex flex-col gap-4 p-4">
      <h1 className="text-lg font-semibold">Earnings</h1>

      <Card>
        <CardHeader>
          <CardTitle>Summary</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-3 gap-3">
          <div>
            <p className="text-xs text-muted-foreground">Accrued</p>
            <p className="font-medium tabular-nums">{formatMoney(earnings.accrued)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Payable</p>
            <p className="font-medium tabular-nums">{formatMoney(earnings.payable)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Paid</p>
            <p className="font-medium tabular-nums">{formatMoney(earnings.paid)}</p>
          </div>
          <div className="col-span-3 border-t border-border pt-3">
            <p className="text-xs text-muted-foreground">
              {formatMoney(earnings.blocked)} blocked by {formatMoney(earnings.pendingCollections)} in pending
              collections
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Grade</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-1 overflow-x-auto">
            {grades.map((grade) => {
              const isCurrent = grade.id === currentGrade?.gradeId;
              return (
                <div key={grade.id} className="flex items-center gap-1">
                  <div
                    className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium ${
                      isCurrent
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border text-muted-foreground"
                    }`}
                  >
                    {grade.code}
                  </div>
                  <span aria-hidden className="text-muted-foreground last:hidden">
                    &rarr;
                  </span>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Statements</CardTitle>
          <CardDescription>Recent commission entries</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col divide-y divide-border">
          {entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">No commission entries yet.</p>
          ) : (
            entries.map((entry) => (
              <Link
                key={entry.id}
                href={`/earnings/${entry.id}/explain`}
                className="flex items-center justify-between py-2 text-sm first:pt-0 last:pb-0"
              >
                <div>
                  <p className="font-medium">{entry.role === "SELF" ? "Self" : `Override, L${entry.level}`}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatDate(entry.accruedAt)} · {entry.status}
                  </p>
                </div>
                <span className="font-medium tabular-nums">{formatMoney(entry.grossAmount)}</span>
              </Link>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
