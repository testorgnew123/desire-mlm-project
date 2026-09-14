import type { Metadata } from "next";
import { FileBarChart } from "lucide-react";
import { getPrismaClient } from "@desire/db";
import { listSavedViews } from "@desire/services/report-schedules";
import { requireSession } from "@/lib/session";
import { formatDateTime } from "@/lib/format";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState } from "@/components/empty-state";
import { createSavedViewAction, deleteSavedViewAction } from "./actions";

export const metadata: Metadata = {
  title: "Reports — Desire",
};

/** docs/20-REPORTS.md catalogues 30 reports across 5 categories. Six real,
 *  row-scoped, audited exemplars ship this slice -- one per category -- via
 *  the shared GET /api/v1/reports/:reportKey route. The remaining ~24 follow
 *  the identical {asOf, columns, rows} pattern and are not built this pass
 *  (PROGRESS.md), stated here rather than left for someone to notice by
 *  counting rows against the doc. */
const REPORTS = [
  { key: "stock-statement", label: "Stock statement", category: "Inventory", description: "Unit-level status across every project." },
  { key: "sales-funnel", label: "Sales funnel", category: "Sales & CRM", description: "Lead stage counts and conversion, scoped to your own or downline leads." },
  { key: "outstanding-aging", label: "Outstanding aging", category: "Collections", description: "Every open demand, bucketed 0-7 / 8-30 / 31-60 / 60+ days overdue." },
  { key: "commission-liability", label: "Commission liability", category: "Commission & payouts", description: "Accrued vs payable vs paid, by associate. Finance-only." },
  { key: "audit-trail", label: "Audit trail", category: "Compliance & audit", description: "Every audited action, filterable by entity and action. Auditor/finance-only." },
  { key: "tally-export", label: "Transaction export", category: "Tally / ERP", description: "Bookings, receipts and payouts as a flat CSV -- not native Tally XML, no ledger-mapping spec exists yet. Finance-only." },
] as const;

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const session = await requireSession();
  const db = getPrismaClient();

  const savedViews = await listSavedViews(db, {
    audit: { orgId: session.user.orgId, actorId: session.user.id, actorLabel: session.user.name },
  });

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold">Reports</h1>
        <p className="text-sm text-muted-foreground">
          6 of the 30 catalogued reports (docs/20-REPORTS.md). Each is real and row-scoped to your access — you may see fewer
          rows, or a 403, depending on your role.
        </p>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {REPORTS.map((report) => (
          <Card key={report.key}>
            <CardHeader>
              <CardTitle className="text-base">{report.label}</CardTitle>
              <CardDescription>{report.category}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm">
              <p className="text-muted-foreground">{report.description}</p>
              <div className="flex gap-3">
                <a href={`/api/v1/reports/${report.key}?format=csv`} className="text-primary hover:underline">
                  Download CSV
                </a>
                <a href={`/api/v1/reports/${report.key}?format=xlsx`} className="text-primary hover:underline">
                  Download XLSX
                </a>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Saved views</CardTitle>
          <CardDescription>
            A name and an optional schedule over one of the reports above. Scheduled views email a CSV — sends only once an
            SMTP account is configured; until then they queue exactly like the report would run manually, with nothing lost.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <form action={createSavedViewAction} className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="reportKey">Report</Label>
              <select id="reportKey" name="reportKey" required className="h-9 rounded-md border border-input bg-transparent px-3 text-sm">
                {REPORTS.map((report) => (
                  <option key={report.key} value={report.key}>
                    {report.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" placeholder="e.g. Weekly stock statement" required className="w-56" />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="scheduleCron">Schedule (cron, optional)</Label>
              <Input id="scheduleCron" name="scheduleCron" placeholder="0 8 * * MON" className="w-40" />
            </div>
            <Button type="submit" size="sm">
              Save view
            </Button>
          </form>

          {savedViews.length === 0 ? (
            <EmptyState icon={FileBarChart} message="No saved views yet." />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-1.5 pr-4">Name</th>
                  <th className="py-1.5 pr-4">Report</th>
                  <th className="py-1.5 pr-4">Schedule</th>
                  <th className="py-1.5 pr-4">Last run</th>
                  <th className="py-1.5 pr-4"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {savedViews.map((view) => (
                  <tr key={view.id}>
                    <td className="py-1.5 pr-4">{view.name}</td>
                    <td className="py-1.5 pr-4">{view.reportKey}</td>
                    <td className="py-1.5 pr-4">{view.scheduleCron ?? "On demand only"}</td>
                    <td className="py-1.5 pr-4">{view.lastRunAt ? formatDateTime(view.lastRunAt) : "Never"}</td>
                    <td className="py-1.5 pr-4">
                      <form action={deleteSavedViewAction}>
                        <input type="hidden" name="id" value={view.id} />
                        <Button type="submit" size="xs" variant="destructive">
                          Delete
                        </Button>
                      </form>
                    </td>
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
