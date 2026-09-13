import type { Metadata } from "next";
import { getPrismaClient } from "@desire/db";
import { getSourceRoi } from "@desire/services/leads";
import { requireSession } from "@/lib/session";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Source ROI — Desire",
};

/** Bookings-per-source vs. leads-per-source (Phase 3.5 Slice 9 -- confirmed
 *  backend gap, closed with leads.ts's new getSourceRoi). */
export default async function SourceRoiPage() {
  const session = await requireSession();
  const db = getPrismaClient();

  const rows = await getSourceRoi(db, { orgId: session.user.orgId, actorId: session.user.id });

  return (
    <main className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold">Source ROI</h1>
      <Card>
        <CardHeader>
          <CardTitle>Leads vs. bookings by source</CardTitle>
          <CardDescription>A "booked" lead has at least one non-cancelled booking</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No leads yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-1.5 pr-4">Source</th>
                  <th className="py-1.5 pr-4 text-right">Leads</th>
                  <th className="py-1.5 pr-4 text-right">Booked</th>
                  <th className="py-1.5 pr-4 text-right">Conversion</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((row) => (
                  <tr key={row.source}>
                    <td className="py-1.5 pr-4">{row.source}</td>
                    <td className="py-1.5 pr-4 text-right tabular-nums">{row.leadCount}</td>
                    <td className="py-1.5 pr-4 text-right tabular-nums">{row.bookingCount}</td>
                    <td className="py-1.5 pr-4 text-right tabular-nums">{row.conversionPct}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
