import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getPrismaClient } from "@desire/db";
import { simulateScheme } from "@desire/services/commission";
import { getSchemeById } from "@desire/services/schemes";
import { requireSession } from "@/lib/session";
import { formatMoney } from "@/lib/money";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Simulate scheme — Desire",
};

const FIELD_CLASS =
  "h-9 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** "No writes" (docs/07-API.md's own contract for this endpoint) -- driven
 *  entirely by a native GET form into this page's own searchParams rather
 *  than a Server Action, since there is nothing to mutate and nothing to
 *  redirect away from; re-running the simulation on every render is exactly
 *  as cheap as the read it is. */
export default async function SimulateSchemePage({
  params,
  searchParams,
}: {
  params: Promise<{ schemeId: string }>;
  searchParams: Promise<{ bookingDate?: string; commissionableValue?: string; saleableAreaAtBooking?: string; sellerAssociateId?: string; error?: string }>;
}) {
  const { schemeId } = await params;
  const query = await searchParams;
  const session = await requireSession();
  const db = getPrismaClient();

  const scheme = await getSchemeById(db, schemeId);
  if (!scheme || scheme.orgId !== session.user.orgId) notFound();

  const associates = await db.associate.findMany({
    where: { orgId: session.user.orgId },
    select: { id: true, code: true, user: { select: { name: true } } },
    orderBy: { code: "asc" },
  });

  const hasInputs = query.bookingDate && query.commissionableValue && query.saleableAreaAtBooking && query.sellerAssociateId;

  let result: Awaited<ReturnType<typeof simulateScheme>> | null = null;
  let error: string | null = null;
  if (hasInputs) {
    try {
      result = await simulateScheme(db, {
        schemeId,
        hypotheticalBooking: {
          bookingDate: query.bookingDate!,
          commissionableValue: query.commissionableValue!,
          saleableAreaAtBooking: query.saleableAreaAtBooking!,
          sellerAssociateId: query.sellerAssociateId!,
        },
        audit: { orgId: session.user.orgId, actorId: session.user.id, actorLabel: session.user.name },
      });
    } catch (e) {
      error = e instanceof Error ? e.message : "Simulation failed.";
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Simulate — {scheme.name} (v{scheme.version})</h1>
        <Link href="/commission/schemes" className="text-sm text-primary hover:underline">
          Schemes
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Hypothetical booking</CardTitle>
        </CardHeader>
        <CardContent>
          <form method="GET" className="grid gap-2 sm:grid-cols-5">
            <Input type="date" name="bookingDate" defaultValue={query.bookingDate} required />
            <Input name="commissionableValue" placeholder="Commissionable value (₹)" defaultValue={query.commissionableValue} required />
            <Input name="saleableAreaAtBooking" placeholder="Saleable area (sq ft)" defaultValue={query.saleableAreaAtBooking} required />
            <select name="sellerAssociateId" defaultValue={query.sellerAssociateId ?? ""} required className={FIELD_CLASS}>
              <option value="" disabled>
                Choose a seller
              </option>
              {associates.map((associate) => (
                <option key={associate.id} value={associate.id}>
                  {associate.user.name} ({associate.code})
                </option>
              ))}
            </select>
            <Button type="submit" size="sm">
              Simulate
            </Button>
          </form>
        </CardContent>
      </Card>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      {result ? (
        <Card>
          <CardHeader>
            <CardTitle>Result</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-1.5 pr-4">Beneficiary</th>
                  <th className="py-1.5 pr-4">Role</th>
                  <th className="py-1.5 pr-4 text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {result.entries.map((entry, i) => (
                  <tr key={i}>
                    <td className="py-1.5 pr-4">{entry.beneficiaryAssociateId}</td>
                    <td className="py-1.5 pr-4">{entry.role === "OVERRIDE" ? `Override L${entry.level}` : "Self"}</td>
                    <td className="py-1.5 pr-4 text-right tabular-nums">{formatMoney(entry.grossAmount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-sm text-muted-foreground">Breakage (unqualified override, retained): {formatMoney(result.breakage)}</p>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
