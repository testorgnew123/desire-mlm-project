import type { Metadata } from "next";
import Link from "next/link";
import { Users } from "lucide-react";
import type { AssociateStatus } from "@desire/db";
import { getPrismaClient } from "@desire/db";
import { listAssociates } from "@desire/services/associates";
import { requireSession } from "@/lib/session";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { associateStatusTone } from "@/lib/status-tone";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Associates — Desire",
};

export default async function AssociatesListPage() {
  const session = await requireSession();
  const db = getPrismaClient();

  const associates = await listAssociates(db, { orgId: session.user.orgId, actorId: session.user.id });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Associates</h1>
        <Link href="/network" className="text-sm text-primary hover:underline">
          Org tree
        </Link>
      </div>

      <Card>
        <CardContent className="overflow-x-auto">
          {associates.length === 0 ? (
            <EmptyState icon={Users} message="No associates." />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-1.5 pr-4">Code</th>
                  <th className="py-1.5 pr-4">Name</th>
                  <th className="py-1.5 pr-4">Grade</th>
                  <th className="py-1.5 pr-4">Status</th>
                  <th className="py-1.5 pr-4 text-right">Depth</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {associates.map((associate) => (
                  <tr key={associate.associateId}>
                    <td className="py-1.5 pr-4">{associate.code}</td>
                    <td className="py-1.5 pr-4">
                      <Link href={`/network/associates/${associate.associateId}`} className="font-medium hover:underline">
                        {associate.name}
                      </Link>
                    </td>
                    <td className="py-1.5 pr-4">{associate.gradeCode ?? "—"}</td>
                    <td className="py-1.5 pr-4">
                      <StatusBadge status={associate.status} tone={associateStatusTone(associate.status as AssociateStatus)} />
                    </td>
                    <td className="py-1.5 pr-4 text-right tabular-nums">{associate.depth}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
