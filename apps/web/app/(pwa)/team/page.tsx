import type { Metadata } from "next";
import { getPrismaClient } from "@desire/db";
import { getAssociateTree } from "@desire/services/associates";
import { requireSession } from "@/lib/session";
import { formatMoney } from "@/lib/money";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = {
  title: "Team — Desire",
};

/** Managers-only downline performance (docs/08-SCREENS.md PWA Team tab;
 *  gated out of the bottom nav entirely for a plain ASSOCIATE by
 *  lib/nav.ts's lead.reassign check). Uses getAssociateTree for the
 *  roster, then a small real aggregation (total non-reversed commission
 *  per downline associate) for "performance" -- no dedicated performance
 *  function exists yet, and this is a plain read, not a new mutation. */
export default async function TeamPage() {
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

  const tree = await getAssociateTree(db, {
    associateId: associate.id,
    orgId: session.user.orgId,
    actorId: session.user.id,
  });

  const downlineIds = tree.downline.map((member) => member.associateId);
  const totals = downlineIds.length
    ? await db.commissionEntry.groupBy({
        by: ["beneficiaryAssociateId"],
        where: { beneficiaryAssociateId: { in: downlineIds }, status: { not: "REVERSED" } },
        _sum: { grossAmount: true },
      })
    : [];
  const totalByAssociateId = new Map(totals.map((row) => [row.beneficiaryAssociateId, row._sum.grossAmount]));

  return (
    <div className="flex flex-col gap-3 p-4">
      <h1 className="text-lg font-semibold">Team</h1>

      {tree.downline.length === 0 ? (
        <p className="text-sm text-muted-foreground">No downline yet.</p>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Downline</CardTitle>
            <CardDescription>{tree.downline.length} associate(s)</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col divide-y divide-border">
            {tree.downline.map((member) => (
              <div key={member.associateId} className="flex items-center justify-between py-2 text-sm first:pt-0 last:pb-0">
                <div>
                  <p className="font-medium">{member.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {member.code} · {member.gradeCode ?? "No grade"} · {member.status}
                  </p>
                </div>
                <span className="font-medium tabular-nums">
                  {formatMoney(totalByAssociateId.get(member.associateId) ?? "0")}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
