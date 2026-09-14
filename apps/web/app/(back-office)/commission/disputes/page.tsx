import type { Metadata } from "next";
import Link from "next/link";
import { Handshake } from "lucide-react";
import { getPrismaClient } from "@desire/db";
import { getCachedSessionPermissions, requireSession } from "@/lib/session";
import { formatDateTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/empty-state";
import { resolveDisputeAction } from "../actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Commission disputes — Desire",
};

/** Phase 3.5 Slice 13 -- confirmed gap, raiseDispute/resolveDispute had zero
 *  routes and no queue view. Queried directly (same as the Projects detail
 *  page's own direct queries, Slice 7) rather than a new list service
 *  function -- this is an org-wide PENDING queue with no O/T/admin scope to
 *  resolve, unlike the ledger. Resolve actions only render for a holder of
 *  commission.dispute_resolve; resolveDispute itself re-checks regardless. */
export default async function CommissionDisputesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const session = await requireSession();
  const db = getPrismaClient();

  const [disputes, permissions] = await Promise.all([
    db.commissionDispute.findMany({
      where: { orgId: session.user.orgId, status: "PENDING" },
      include: {
        entry: {
          select: {
            id: true,
            grossAmount: true,
            beneficiaryAssociateId: true,
            beneficiary: { select: { code: true, user: { select: { name: true } } } },
          },
        },
      },
      orderBy: { createdAt: "asc" },
    }),
    getCachedSessionPermissions(db, session.user.id),
  ]);

  const canResolve = permissions.has("commission.dispute_resolve");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Commission disputes</h1>
        <Link href="/commission" className="text-sm text-primary hover:underline">
          Ledger
        </Link>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      {disputes.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState icon={Handshake} message="No pending disputes." />
          </CardContent>
        </Card>
      ) : (
        disputes.map((dispute) => (
          <Card key={dispute.id}>
            <CardContent className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <div>
                  <Link href={`/earnings/${dispute.entry.id}/explain`} className="font-medium hover:underline">
                    {dispute.entry.beneficiary.user.name} ({dispute.entry.beneficiary.code})
                  </Link>
                  <p className="text-sm text-muted-foreground">Raised {formatDateTime(dispute.createdAt)}</p>
                </div>
              </div>
              <p className="text-sm">{dispute.description}</p>
              {canResolve ? (
                <div className="flex flex-wrap gap-2">
                  <form action={resolveDisputeAction} className="flex flex-wrap items-center gap-1.5">
                    <input type="hidden" name="disputeId" value={dispute.id} />
                    <input type="hidden" name="resolution" value="APPROVED" />
                    <Input name="adjustmentAmount" placeholder="Adjustment (₹, optional)" className="h-7 w-40 text-xs" />
                    <Input name="resolutionNote" placeholder="Note (optional)" className="h-7 w-40 text-xs" />
                    <Button type="submit" size="xs">
                      Approve
                    </Button>
                  </form>
                  <form action={resolveDisputeAction} className="flex items-center gap-1.5">
                    <input type="hidden" name="disputeId" value={dispute.id} />
                    <input type="hidden" name="resolution" value="REJECTED" />
                    <Input name="resolutionNote" placeholder="Note (optional)" className="h-7 w-40 text-xs" />
                    <Button type="submit" size="xs" variant="destructive">
                      Reject
                    </Button>
                  </form>
                </div>
              ) : null}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
