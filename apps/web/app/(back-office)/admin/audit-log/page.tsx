import type { Metadata } from "next";
import Link from "next/link";
import { ClipboardList } from "lucide-react";
import type { AuditAction } from "@desire/db";
import { getPrismaClient } from "@desire/db";
import { listAuditLog } from "@desire/services/audit";
import { requireSession } from "@/lib/session";
import { formatDateTime } from "@/lib/format";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Audit log — Desire",
};

const ACTIONS: AuditAction[] = ["CREATE", "UPDATE", "DELETE", "APPROVE", "REJECT", "LOGIN", "LOGIN_FAILED", "LOGOUT", "EXPORT", "VIEW_SENSITIVE"];

/** Read-only, filterable -- Phase 3.5 Slice 15 -- confirmed gap,
 *  writeAuditLog is used everywhere but nothing ever read it back. Capped
 *  at 500 rows (listAuditLog's own limit): this is a browsing screen, not
 *  the CSV/XLSX bulk export docs/20-REPORTS.md describes and this phase
 *  explicitly defers. */
export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<{ entity?: string; action?: string }>;
}) {
  const { entity, action } = await searchParams;
  const session = await requireSession();
  const db = getPrismaClient();

  const selectedAction = ACTIONS.includes(action as AuditAction) ? (action as AuditAction) : undefined;
  const rows = await listAuditLog(db, {
    orgId: session.user.orgId,
    actorId: session.user.id,
    entity: entity || undefined,
    action: selectedAction,
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Audit log</h1>
        <Link href="/admin" className="text-sm text-primary hover:underline">
          Admin
        </Link>
      </div>

      <form className="flex flex-wrap gap-2" method="GET">
        <input
          name="entity"
          defaultValue={entity}
          placeholder="Filter by entity (e.g. Booking)"
          className="h-9 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
        <select
          name="action"
          defaultValue={selectedAction ?? ""}
          className="h-9 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <option value="">All actions</option>
          {ACTIONS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="inline-flex h-9 items-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/80"
        >
          Filter
        </button>
      </form>

      <Card>
        <CardContent className="overflow-x-auto">
          {rows.length === 0 ? (
            <EmptyState icon={ClipboardList} message="No matching audit rows." />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-1.5 pr-4">When</th>
                  <th className="py-1.5 pr-4">Actor</th>
                  <th className="py-1.5 pr-4">Action</th>
                  <th className="py-1.5 pr-4">Entity</th>
                  <th className="py-1.5 pr-4">Entity ID</th>
                  <th className="py-1.5 pr-4">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="py-1.5 pr-4 tabular-nums">{formatDateTime(row.createdAt)}</td>
                    <td className="py-1.5 pr-4">{row.actorLabel}</td>
                    <td className="py-1.5 pr-4">{row.action}</td>
                    <td className="py-1.5 pr-4">{row.entity}</td>
                    <td className="py-1.5 pr-4 font-mono text-xs">{row.entityId}</td>
                    <td className="py-1.5 pr-4">{row.reason ?? "—"}</td>
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
