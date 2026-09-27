"use client";

// The associate's plot grid (docs/08-SCREENS.md: "Inventory -- Browse,
// filter, unit detail, hold").
//
// This was a single-column list until a client reported that inventory "is
// showing as a list" -- reasonably, since a plot map is how anyone selling
// real estate thinks about stock. It now uses the SAME tiles as the desktop
// board (UnitTile + board.module.css tone classes) on top of the same
// delta-poll hook, catalogue shape and status presentation it already
// shared. One tile implementation and one status->colour mapping, so the
// phone and the board cannot drift apart about what a colour means.
//
// Differs from the board in two deliberate ways, both because this is a
// phone: every tower is in one scrolling list with a sticky heading rather
// than behind a tower switcher, and the layout CSS is local (grid.module.css)
// because board.module.css's `.board` root is a full-page desktop shell.
//
// The hold POST is the one place a client-side fetch is justified over a
// Server Action, matching the board's own existing pattern (the route
// already exists and is GATE-tested; no reason to wrap it).
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useUnitDeltas } from "@/app/board/[projectId]/useUnitDeltas";
import { STATUS_PRESENTATION, displayStatus } from "@/app/board/[projectId]/status";
import { UnitTile } from "@/app/board/[projectId]/UnitTile";
import { EXPIRY_WARNING_MS, formatCountdown } from "@/app/board/[projectId]/format";
import { formatDateTime } from "@/lib/format";
import type { BoardUnit } from "@/app/board/[projectId]/types";
import styles from "./grid.module.css";
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

// A local 3-of-7 status->text-colour map used to live here. It is gone: the
// tiles carry status via board.module.css's tone classes now, which cover all
// seven and match the desktop board. One fewer parallel colour convention.

export function InventoryGrid({
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

  // One-second tick, the same as the desktop board's. The tiles show a live
  // hold countdown, and displayStatus below needs a clock to apply lazy
  // expiry -- without this a held tile would keep saying HELD after its hold
  // had actually lapsed, until the next delta poll happened to land.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

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
  // Lazy expiry applied once, here, so the tile, the detail sheet and the
  // "Hold this unit" button can never disagree about whether a lapsed hold
  // still counts.
  const selectedStatus = selected === null ? null : displayStatus(selected, nowMs);

  // Tower, then floor descending -- the board's building-elevation reading
  // order (InventoryBoard's floorSections). The board uses a tower switcher;
  // one scrolling list with a sticky tower heading suits a phone better and
  // keeps every plot reachable by thumb.
  const towerSections = useMemo(() => {
    const byTower = new Map<string, { towerCode: string | null; units: typeof merged }>();
    for (const unit of merged) {
      const key = unit.towerCode ?? "";
      let section = byTower.get(key);
      if (!section) {
        section = { towerCode: unit.towerCode, units: [] };
        byTower.set(key, section);
      }
      section.units.push(unit);
    }
    return [...byTower.values()]
      .sort((a, b) => (a.towerCode ?? "").localeCompare(b.towerCode ?? ""))
      .map((section) => {
        const byFloor = new Map<number, typeof merged>();
        for (const unit of section.units) {
          const row = byFloor.get(unit.floor);
          if (row) row.push(unit);
          else byFloor.set(unit.floor, [unit]);
        }
        return {
          towerCode: section.towerCode,
          floors: [...byFloor.entries()]
            .sort((a, b) => b[0] - a[0])
            .map(([floor, units]) => ({
              floor,
              units: [...units].sort((a, b) => a.unitNumber.localeCompare(b.unitNumber)),
            })),
        };
      });
  }, [merged]);

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
      <div className={styles.grid}>
        {towerSections.map((section) => (
          <section key={section.towerCode ?? "_"} className={styles.tower}>
            {section.towerCode ? (
              <h2 className={styles.towerLabel}>Tower {section.towerCode}</h2>
            ) : null}
            {section.floors.map(({ floor, units: floorUnits }) => (
              <div key={floor} className={styles.floorRow}>
                <div className={styles.floorLabel} aria-hidden="true">
                  {floor}
                </div>
                <div className={styles.floorUnits}>
                  {floorUnits.map((unit) => {
                    const status = displayStatus(unit, nowMs);
                    const remainingMs =
                      status === "HELD" && unit.currentHoldExpiresAt !== null
                        ? Date.parse(unit.currentHoldExpiresAt) - nowMs
                        : null;
                    return (
                      <UnitTile
                        key={unit.id}
                        unitId={unit.id}
                        unitNumber={unit.unitNumber}
                        floor={unit.floor}
                        unitTypeCode={unit.unitTypeCode}
                        status={status}
                        countdown={remainingMs === null ? null : formatCountdown(remainingMs)}
                        remainingMinutes={
                          remainingMs === null ? null : Math.floor(remainingMs / 60_000)
                        }
                        urgent={remainingMs !== null && remainingMs <= EXPIRY_WARNING_MS}
                        selected={unit.id === selectedId}
                        onSelect={(unitId) => {
                          setHoldError(null);
                          setSelectedId(unitId);
                        }}
                      />
                    );
                  })}
                </div>
              </div>
            ))}
          </section>
        ))}
      </div>

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
                  <span>{STATUS_PRESENTATION[selectedStatus ?? selected.status].long}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Carpet</span>
                  <span>{selected.carpetArea}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Saleable</span>
                  <span>{selected.saleableArea}</span>
                </div>
                {selectedStatus === "HELD" && selected.currentHoldExpiresAt ? (
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
              {selectedStatus === "AVAILABLE" ? (
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
