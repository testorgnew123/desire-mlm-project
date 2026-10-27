import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CircleAlert } from "lucide-react";
import { getPrismaClient } from "@desire/db";
import { isHoldLive } from "@desire/services/holds";
import { getSession } from "@/lib/session";
import { formatArea } from "@/lib/money";
import { formatDateTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { bookPlotAction, releaseHoldFormAction } from "./actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Book a plot — Desire",
};

/** Booking a plot, from the associate's phone: who is buying, then one button.
 *  The form is only offered while the plot can actually be booked by this person
 *  -- free, or already held by them; for anything else the page says why instead
 *  of letting them fill in a form that cannot succeed. bookPlot re-checks all of
 *  it at submit, since the state can change in between. */
export default async function BookPlotPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; unitId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { projectId, unitId } = await params;
  const { error } = await searchParams;
  const session = await getSession();
  if (!session) notFound();
  const db = getPrismaClient();

  const [unit, associate] = await Promise.all([
    db.unit.findFirst({
      where: { id: unitId, projectId, orgId: session.user.orgId },
      select: {
        id: true,
        unitNumber: true,
        status: true,
        saleableAreaOverride: true,
        tower: { select: { code: true } },
        unitType: { select: { name: true, areaBasis: true, saleableArea: true } },
        project: { select: { name: true } },
        // At most one row: the partial unique index one_active_hold_per_unit.
        holds: { where: { releasedAt: null }, select: { expiresAt: true, releasedAt: true, associateId: true }, take: 1 },
      },
    }),
    db.associate.findUnique({ where: { userId: session.user.id }, select: { id: true } }),
  ]);
  if (!unit) notFound();

  const hold = unit.holds[0] ?? null;
  const heldByMe = !!associate && !!hold && hold.associateId === associate.id && isHoldLive(hold);
  const heldByOther = !!hold && !heldByMe && isHoldLive(hold);
  // HELD with no live hold of anyone's is a lapsed hold, which acquireHold frees
  // on the way in, so it is bookable like an available plot.
  const bookable = !!associate && !heldByOther && (unit.status === "AVAILABLE" || unit.status === "HELD");

  const area = formatArea(unit.saleableAreaOverride ?? unit.unitType.saleableArea, "saleable", unit.unitType.areaBasis);

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <h1 className="text-lg font-semibold">Book plot {unit.unitNumber}</h1>
        <p className="text-sm text-muted-foreground">
          {unit.project.name}
          {unit.tower ? ` · Block ${unit.tower.code}` : ""} · {unit.unitType.name}
          {area ? ` · ${area}` : ""}
        </p>
      </div>

      {error ? (
        <p role="alert" className="flex items-start gap-1.5 text-sm text-danger">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          {error}
        </p>
      ) : null}

      {!associate ? (
        <p className="text-sm text-muted-foreground">
          Only an associate can book a plot, and this account has no associate profile.
        </p>
      ) : !bookable ? (
        <p className="text-sm text-muted-foreground">
          {heldByOther
            ? "Another associate is holding this plot right now."
            : `This plot is ${unit.status.toLowerCase().replaceAll("_", " ")} and cannot be booked.`}
        </p>
      ) : (
        <form action={bookPlotAction} className="flex flex-col gap-3">
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="unitId" value={unit.id} />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name">Customer name</Label>
            <Input id="name" name="name" autoComplete="off" required autoFocus />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="phone">Mobile number</Label>
            <Input id="phone" name="phone" type="tel" inputMode="tel" autoComplete="off" required />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">Email (optional)</Label>
            <Input id="email" name="email" type="email" autoComplete="off" />
          </div>
          <p className="text-xs text-muted-foreground">
            {heldByMe && hold
              ? `You are holding this plot until ${formatDateTime(hold.expiresAt)}. `
              : "Booking holds the plot for you. "}
            An admin confirms the booking afterwards.
          </p>
          <Button type="submit" className="w-full">
            Book this plot
          </Button>
        </form>
      )}

      {heldByMe ? (
        // Not ready to book after all: give the plot back to everyone. Refused
        // while a draft booking from this hold waits for an admin.
        <form action={releaseHoldFormAction}>
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="unitId" value={unit.id} />
          <Button type="submit" variant="outline" className="w-full">
            Release hold
          </Button>
        </form>
      ) : null}

      <Link href={`/inventory/${projectId}`} className="text-center text-sm text-primary hover:underline">
        Back to the plots
      </Link>
    </div>
  );
}
