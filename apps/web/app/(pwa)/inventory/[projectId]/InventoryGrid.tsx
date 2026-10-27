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
// Hold and Release call Server Actions (./actions.ts), not the REST route the
// board uses (unchanged): an action's revalidatePath refreshes this page in the
// same response, with a new server time that also drops the delta overlay below,
// so a plot you just held is still yours on screen and Book stays available.
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useUnitDeltas } from "@/app/board/[projectId]/useUnitDeltas";
import { STATUS_PRESENTATION, displayStatus } from "@/app/board/[projectId]/status";
import { UnitTile } from "@/app/board/[projectId]/UnitTile";
import { EXPIRY_WARNING_MS, formatCountdown } from "@/app/board/[projectId]/format";
import { formatDateTime } from "@/lib/format";
import { groupNoun, type GroupKind } from "@/lib/groups";
import { expandCatalogue, type Catalogue, type CatalogueUnit } from "@/app/board/[projectId]/catalogue";
import styles from "./grid.module.css";
import { holdPlotAction, releaseHoldAction } from "./actions";
import { plotSheetActions } from "./plot-sheet";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

// A local 3-of-7 status->text-colour map used to live here. It is gone: the
// tiles carry status via board.module.css's tone classes now, which cover all
// seven and match the desktop board. One fewer parallel colour convention.

export function InventoryGrid({
  projectId,
  projectName,
  catalogue,
  serverTime,
  holdInfo,
}: {
  projectId: string;
  projectName: string;
  /** The units and blocks in the compact form that crosses the wire (catalogue.ts). */
  catalogue: Catalogue;
  serverTime: string;
  /** The viewer's hold allowance and how much of it is in use, or null when the
   *  account has no associate profile (only associates hold and book). */
  holdInfo: { quota: number; live: number } | null;
}) {
  const router = useRouter();
  // Rebuilt once per snapshot, not per render: `merged` below depends on its identity.
  const units = useMemo(() => expandCatalogue(catalogue).units, [catalogue]);
  const knownUnitIds = useMemo(() => new Set(units.map((unit) => unit.id)), [units]);
  const { live, isFetching, error } = useUnitDeltas({
    projectId,
    initialServerTime: serverTime,
    knownUnitIds,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Which block's plots are drawn. A township is many blocks of a hundred plots;
  // drawing all of them at once put thousands of tiles in the page (and in the
  // HTML sent to a phone) for a screen that shows thirty.
  const [activeBlock, setActiveBlock] = useState<string | null>(null);
  const [busy, setBusy] = useState<"hold" | "release" | null>(null);
  const [holdError, setHoldError] = useState<string | null>(null);

  // The clock behind the hold countdowns, and behind displayStatus's lazy
  // expiry -- without it a held tile would keep saying HELD after its hold had
  // actually lapsed, until the next delta poll happened to land.
  //
  // It used to tick every second unconditionally, and each tick re-rendered the
  // whole grid: with a township's worth of plots that is thousands of tiles
  // re-sorted and re-diffed every second, in a hidden tab as well. Now it runs
  // only while some plot is HELD (nothing to count down otherwise) and the tab is
  // visible, and catches up the moment it becomes visible again.
  const [nowMs, setNowMs] = useState(() => Date.now());

  // The delta poll carries no holder identity (docs/06-INVENTORY-SPEC.md
  // section 6: {id, unitNumber, floor, status, currentHoldExpiresAt,
  // updatedAt} only) -- exactly the same limitation the desktop board
  // already solves (InventoryBoard.tsx's holderIsFromSnapshot). A unit
  // whose status came from a live delta must NOT keep showing the
  // snapshot's isMine/heldByName -- that snapshot predates this hold and
  // could easily label someone else's hold "You".
  //
  // Memoised on what it actually depends on. It used to be rebuilt on every
  // render -- every clock tick -- which also defeated the useMemo below that
  // groups it, so the whole list was regrouped and re-sorted each second.
  const merged = useMemo(
    () =>
      units.map((unit) => {
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
      }),
    [units, live],
  );
  const anyHeld = useMemo(() => merged.some((unit) => unit.status === "HELD"), [merged]);
  useEffect(() => {
    if (!anyHeld) return;
    const tick = () => {
      if (document.visibilityState === "visible") setNowMs(Date.now());
    };
    tick();
    const id = setInterval(tick, 1000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [anyHeld]);
  const selected = merged.find((unit) => unit.id === selectedId) ?? null;
  // Lazy expiry applied once, here, so the tile, the detail sheet and the
  // "Hold this unit" button can never disagree about whether a lapsed hold
  // still counts.
  const selectedStatus = selected === null ? null : displayStatus(selected, nowMs);
  const sheet =
    selected === null || selectedStatus === null
      ? null
      : plotSheetActions({
          status: selectedStatus,
          isMine: selected.isMine,
          holderUnknown: selected.holderUnknown,
          viewerIsAssociate: holdInfo !== null,
        });

  // Tower, then floor descending -- the board's building-elevation reading
  // order (InventoryBoard's floorSections). The board uses a tower switcher;
  // one scrolling list with a sticky tower heading suits a phone better and
  // keeps every plot reachable by thumb.
  const towerSections = useMemo(() => {
    const byTower = new Map<
      string,
      { towerCode: string | null; towerKind: GroupKind | null; units: typeof merged }
    >();
    for (const unit of merged) {
      const key = unit.towerCode ?? "";
      let section = byTower.get(key);
      if (!section) {
        section = { towerCode: unit.towerCode, towerKind: unit.towerKind, units: [] };
        byTower.set(key, section);
      }
      section.units.push(unit);
    }
    return [...byTower.values()]
      .sort((a, b) => (a.towerCode ?? "").localeCompare(b.towerCode ?? ""))
      .map((section) => {
        // Plots have no floor. They collect into one floorless row rendered
        // without a floor label, rather than being forced into a "floor 0"
        // band that does not exist on the ground.
        const byFloor = new Map<number, typeof merged>();
        const floorless: typeof merged = [];
        for (const unit of section.units) {
          if (unit.floor === null) {
            floorless.push(unit);
            continue;
          }
          const row = byFloor.get(unit.floor);
          if (row) row.push(unit);
          else byFloor.set(unit.floor, [unit]);
        }
        const floors: Array<{ floor: number | null; units: typeof merged }> = [
          ...byFloor.entries(),
        ]
          .sort((a, b) => b[0] - a[0])
          .map(([floor, units]) => ({
            floor: floor as number | null,
            units: [...units].sort((a, b) => a.unitNumber.localeCompare(b.unitNumber)),
          }));
        if (floorless.length > 0) {
          floors.push({
            floor: null,
            units: [...floorless].sort((a, b) => a.unitNumber.localeCompare(b.unitNumber)),
          });
        }
        return { towerCode: section.towerCode, towerKind: section.towerKind, floors };
      });
  }, [merged]);


  const sectionKey = (towerCode: string | null) => towerCode ?? "_";
  const firstSection = towerSections[0];
  const shownKey = activeBlock ?? (firstSection ? sectionKey(firstSection.towerCode) : "_");
  const matching = towerSections.filter((section) => sectionKey(section.towerCode) === shownKey);
  // Falls back to the first block if the chosen one is gone from the list.
  const shownSections = towerSections.length <= 1 || matching.length === 0 ? towerSections.slice(0, 1) : matching;

  /** Hold or release, then leave the sheet open: on success the page has been
   *  refreshed by the action (revalidatePath) and the sheet now shows what the
   *  plot is, your hold with its countdown and Book; on a refusal it says why. */
  async function runHoldAction(kind: "hold" | "release", unit: CatalogueUnit) {
    setBusy(kind);
    setHoldError(null);
    try {
      const result = await (kind === "hold" ? holdPlotAction : releaseHoldAction)(projectId, unit.id);
      if (!result.ok) setHoldError(result.message);
    } catch {
      setHoldError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(null);
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
      {towerSections.length > 1 ? (
        <div className="flex gap-2 overflow-x-auto border-b border-border px-4 py-2" role="tablist" aria-label="Blocks">
          {towerSections.map((section) => {
            const key = sectionKey(section.towerCode);
            const count = section.floors.reduce((sum, floor) => sum + floor.units.length, 0);
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={key === shownKey}
                onClick={() => setActiveBlock(key)}
                className={`shrink-0 rounded-full border px-3 py-1 text-xs font-medium ${
                  key === shownKey ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground"
                }`}
              >
                {groupNoun(section.towerKind)} {section.towerCode ?? "—"} · {count}
              </button>
            );
          })}
        </div>
      ) : null}
      <div className={styles.grid}>
        {shownSections.map((section) => (
          <section key={section.towerCode ?? "_"} className={styles.tower}>
            {section.towerCode ? (
              <h2 className={styles.towerLabel}>
                {groupNoun(section.towerKind)} {section.towerCode}
              </h2>
            ) : null}
            {section.floors.map(({ floor, units: floorUnits }) => (
              <div key={floor ?? "plots"} className={styles.floorRow}>
                {/* Empty for plots: the label column stays so the grid keeps
                    its left gutter and tiles stay aligned across sections. */}
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
                        mine={status === "HELD" && unit.isMine && !unit.holderUnknown}
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
                  {selected.towerCode
                    ? ` · ${groupNoun(selected.towerKind)} ${selected.towerCode}`
                    : ""}
                  {selected.floor !== null ? ` · Floor ${selected.floor}` : ""}
                </SheetDescription>
              </SheetHeader>
              <div className="flex flex-col gap-2 px-4 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Status</span>
                  <span>{STATUS_PRESENTATION[selectedStatus ?? selected.status].long}</span>
                </div>
                {/* A plot has no carpet area (null), so the row is omitted. */}
                {selected.carpetArea !== null ? (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Carpet</span>
                    <span>{selected.carpetArea}</span>
                  </div>
                ) : null}
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
                          ? `${formatDateTime(selected.currentHoldExpiresAt)} (${formatCountdown(
                              Math.max(0, Date.parse(selected.currentHoldExpiresAt) - nowMs),
                            )} left)`
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
              {/* Two things an associate does with a free plot: BOOK it (which takes
                  the hold itself, then asks for the customer) or HOLD it to
                  reserve it without a customer yet. Once it is held by them, Book
                  carries on from that hold and Release gives it back. */}
              {sheet && (sheet.canBook || sheet.canHold || sheet.canRelease) ? (
                <SheetFooter>
                  {sheet.canBook ? (
                    <Button
                      nativeButton={false}
                      render={<Link href={`/inventory/${projectId}/${selected.id}/book`} />}
                      className="w-full"
                    >
                      Book this plot
                    </Button>
                  ) : null}
                  {sheet.canHold ? (
                    <Button
                      variant="outline"
                      onClick={() => runHoldAction("hold", selected)}
                      disabled={busy !== null}
                      className="w-full"
                    >
                      {busy === "hold" ? "Holding…" : "Hold this plot"}
                    </Button>
                  ) : null}
                  {sheet.canRelease ? (
                    <Button
                      variant="outline"
                      onClick={() => runHoldAction("release", selected)}
                      disabled={busy !== null}
                      className="w-full"
                    >
                      {busy === "release" ? "Releasing…" : "Release hold"}
                    </Button>
                  ) : null}
                  {holdInfo ? (
                    <p className="text-center text-xs text-muted-foreground">
                      Holds used {holdInfo.live} of {holdInfo.quota}
                    </p>
                  ) : null}
                </SheetFooter>
              ) : sheet?.note ? (
                <p className="px-4 pb-4 text-sm text-muted-foreground">{sheet.note}</p>
              ) : null}
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
