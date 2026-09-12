"use client";

// Single-column mobile list, not the desktop tower/floor grid -- but the
// SAME delta-poll hook, catalogue shape, and status presentation data as
// the board (docs/08-SCREENS.md: "Inventory -- Browse, filter, unit detail,
// hold"). The hold POST is the one place a client-side fetch is justified
// over a Server Action, matching the board's own existing pattern (the
// route already exists and is GATE-tested; no reason to wrap it).
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useUnitDeltas } from "@/app/board/[projectId]/useUnitDeltas";
import { STATUS_PRESENTATION } from "@/app/board/[projectId]/status";
import { formatDateTime } from "@/lib/format";
import type { BoardUnit } from "@/app/board/[projectId]/types";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

type PwaUnit = BoardUnit & { towerCode: string | null; isMine: boolean };

const STATUS_TONE: Partial<Record<BoardUnit["status"], string>> = {
  AVAILABLE: "text-success",
  HELD: "text-warning",
  BLOCKED: "text-danger",
};

export function InventoryList({
  projectId,
  projectName,
  units,
  serverTime,
}: {
  projectId: string;
  projectName: string;
  units: PwaUnit[];
  serverTime: string;
}) {
  const router = useRouter();
  const knownUnitIds = new Set(units.map((unit) => unit.id));
  const { live, refreshNow, isFetching, error } = useUnitDeltas({
    projectId,
    initialServerTime: serverTime,
    knownUnitIds,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [holding, setHolding] = useState(false);
  const [holdError, setHoldError] = useState<string | null>(null);

  // The delta poll carries no holder identity (docs/06-INVENTORY-SPEC.md
  // section 6: {id, unitNumber, floor, status, currentHoldExpiresAt,
  // updatedAt} only) -- exactly the same limitation the desktop board
  // already solves (InventoryBoard.tsx's holderIsFromSnapshot). A unit
  // whose status came from a live delta must NOT keep showing the
  // snapshot's isMine/heldByName -- that snapshot predates this hold and
  // could easily label someone else's hold "You".
  const merged = units.map((unit) => {
    const overlay = live[unit.id];
    if (!overlay) return { ...unit, holderUnknown: false };
    return {
      ...unit,
      status: overlay.status,
      currentHoldExpiresAt: overlay.currentHoldExpiresAt,
      updatedAt: overlay.updatedAt,
      isMine: false,
      heldByName: null,
      heldByCode: null,
      holderUnknown: true,
    };
  });
  const selected = merged.find((unit) => unit.id === selectedId) ?? null;

  async function handleHold(unit: PwaUnit) {
    setHolding(true);
    setHoldError(null);
    try {
      const response = await fetch(`/api/v1/projects/${projectId}/units/${unit.id}/holds`, {
        method: "POST",
        credentials: "same-origin",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { detail?: string } | null;
        // Never a generic error -- "Just taken by Ravi (A-0042)" is the
        // whole point (docs/08-SCREENS.md).
        throw new Error(body?.detail ?? `Hold failed (HTTP ${response.status}).`);
      }
      refreshNow();
      setSelectedId(null);
    } catch (caught) {
      setHoldError(caught instanceof Error ? caught.message : "Hold failed.");
    } finally {
      setHolding(false);
    }
  }

  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-10 border-b border-border bg-background p-4">
        <h1 className="text-lg font-semibold">{projectName}</h1>
        <p className="text-xs text-muted-foreground">
          {isFetching ? "Refreshing…" : error ? error : `${merged.length} units`}
        </p>
      </div>
      <ul className="divide-y divide-border">
        {merged.map((unit) => {
          const presentation = STATUS_PRESENTATION[unit.status];
          return (
            <li key={unit.id}>
              <button
                type="button"
                onClick={() => {
                  setHoldError(null);
                  setSelectedId(unit.id);
                }}
                className="flex w-full items-center justify-between px-4 py-3 text-left"
              >
                <div>
                  <p className="font-medium">
                    {unit.unitNumber}
                    {unit.towerCode ? ` · Tower ${unit.towerCode}` : ""}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {unit.unitTypeName} · Floor {unit.floor}
                  </p>
                </div>
                <span
                  className={`flex items-center gap-1 text-sm font-medium ${STATUS_TONE[unit.status] ?? "text-muted-foreground"}`}
                >
                  <span aria-hidden>{presentation.glyph}</span>
                  {presentation.long}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <Sheet open={selected !== null} onOpenChange={(open) => !open && setSelectedId(null)}>
        <SheetContent side="bottom">
          {selected ? (
            <>
              <SheetHeader>
                <SheetTitle>{selected.unitNumber}</SheetTitle>
                <SheetDescription>
                  {selected.unitTypeName}
                  {selected.towerCode ? ` · Tower ${selected.towerCode}` : ""} · Floor {selected.floor}
                </SheetDescription>
              </SheetHeader>
              <div className="flex flex-col gap-2 px-4 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Status</span>
                  <span>{STATUS_PRESENTATION[selected.status].long}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Carpet</span>
                  <span>{selected.carpetArea}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Saleable</span>
                  <span>{selected.saleableArea}</span>
                </div>
                {selected.status === "HELD" && selected.currentHoldExpiresAt ? (
                  selected.holderUnknown ? (
                    <p className="text-muted-foreground">
                      Taken since this list loaded.{" "}
                      <button type="button" onClick={() => router.refresh()} className="underline">
                        Refresh
                      </button>{" "}
                      to see who.
                    </p>
                  ) : (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">{selected.isMine ? "Your hold expires" : "Held by"}</span>
                      <span>
                        {selected.isMine
                          ? formatDateTime(selected.currentHoldExpiresAt)
                          : (selected.heldByName ?? "Another associate")}
                      </span>
                    </div>
                  )
                ) : null}
                {holdError ? (
                  <p role="alert" className="text-danger">
                    {holdError}
                  </p>
                ) : null}
              </div>
              {selected.status === "AVAILABLE" ? (
                <SheetFooter>
                  <Button onClick={() => handleHold(selected)} disabled={holding} className="w-full">
                    {holding ? "Holding…" : "Hold this unit"}
                  </Button>
                </SheetFooter>
              ) : null}
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
