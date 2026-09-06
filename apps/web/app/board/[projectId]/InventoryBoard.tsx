"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { UnitStatus } from "@desire/db";
import { FilterRail } from "./FilterRail";
import { UnitDrawer } from "./UnitDrawer";
import { UnitTile } from "./UnitTile";
import { EXPIRY_WARNING_MS, formatCountdown, formatIstClock } from "./format";
import {
  EMPTY_FILTERS,
  countActiveFilters,
  matchesAttributeFilters,
  type BoardFilters,
} from "./filters";
import { useUnitDeltas } from "./useUnitDeltas";
import type { BoardTower, BoardUnit, LiveUnitState } from "./types";
import styles from "./board.module.css";

/** Unit.towerId is nullable in the schema, so "no tower" is a real group. */
const NO_TOWER = "__no_tower__";

export interface InventoryBoardProps {
  projectId: string;
  projectName: string;
  projectCode: string;
  city: string;
  towers: BoardTower[];
  units: BoardUnit[];
  /** serverTime of the snapshot in `units`. */
  serverTime: string;
}

/** Lazy expiry, client side (docs/06-INVENTORY-SPEC.md section 3): ANY read
 *  treats a hold past its expiresAt as gone. This is the same rule
 *  effectiveUnitStatus applies on the server, so the tile flips to AVAILABLE
 *  the second the countdown runs out instead of lying until the next poll --
 *  and when that poll lands, it agrees. */
function displayStatus(state: LiveUnitState, nowMs: number): UnitStatus {
  if (state.status !== "HELD") return state.status;
  const expiresAtMs =
    state.currentHoldExpiresAt === null ? null : Date.parse(state.currentHoldExpiresAt);
  return expiresAtMs === null || expiresAtMs <= nowMs ? "AVAILABLE" : "HELD";
}

function emptyStatusCounts(): Record<UnitStatus, number> {
  return {
    AVAILABLE: 0,
    HELD: 0,
    BOOKED: 0,
    AGREEMENT_SIGNED: 0,
    REGISTERED: 0,
    POSSESSION: 0,
    BLOCKED: 0,
  };
}

export function InventoryBoard({
  projectId,
  projectName,
  projectCode,
  city,
  towers,
  units,
  serverTime,
}: InventoryBoardProps) {
  const router = useRouter();

  const knownUnitIds = useMemo(() => new Set(units.map((unit) => unit.id)), [units]);
  const { live, skewMs, lastSyncedAt, isFetching, isPaused, error, unknownUnitIds, refreshNow } =
    useUnitDeltas({ projectId, initialServerTime: serverTime, knownUnitIds });

  // Seeded from the server snapshot rather than Date.now() so the server render
  // and the client hydration agree exactly; the ticker below corrects it to the
  // real, skew-adjusted clock on mount.
  const [nowMs, setNowMs] = useState(() => Date.parse(serverTime));
  const [filters, setFilters] = useState<BoardFilters>(EMPTY_FILTERS);
  const [towerKey, setTowerKey] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedUnitId, setSelectedUnitId] = useState<string | null>(null);
  const [isReloading, setIsReloading] = useState(false);
  const lastTriggerRef = useRef<HTMLButtonElement | null>(null);

  // Collapsed by default so the grid is the first thing on a 360px phone, open
  // where there is room for the rail beside it (docs/08-SCREENS.md).
  useEffect(() => {
    setFiltersOpen(window.matchMedia("(min-width: 760px)").matches);
  }, []);

  useEffect(() => {
    setIsReloading(false);
  }, [serverTime]);

  const towerGroups = useMemo(() => {
    const counts = new Map<string, number>();
    for (const unit of units) {
      const key = unit.towerId ?? NO_TOWER;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const groups: Array<{ key: string; label: string; count: number }> = [];
    for (const tower of towers) {
      const count = counts.get(tower.id);
      if (count !== undefined) groups.push({ key: tower.id, label: tower.code, count });
    }
    const loose = counts.get(NO_TOWER);
    if (loose !== undefined) groups.push({ key: NO_TOWER, label: "No tower", count: loose });
    return groups;
  }, [towers, units]);

  // Derived rather than corrected in state: a full reload can retire the tower
  // that was selected, and falling back at render keeps that from becoming a
  // blank grid.
  const activeTowerKey =
    towerKey !== null && towerGroups.some((group) => group.key === towerKey)
      ? towerKey
      : (towerGroups[0]?.key ?? NO_TOWER);

  const unitTypeOptions = useMemo(() => {
    const byId = new Map<string, { id: string; code: string; name: string }>();
    for (const unit of units) {
      if (!byId.has(unit.unitTypeId)) {
        byId.set(unit.unitTypeId, {
          id: unit.unitTypeId,
          code: unit.unitTypeCode,
          name: unit.unitTypeName,
        });
      }
    }
    return [...byId.values()].sort((a, b) => a.code.localeCompare(b.code));
  }, [units]);

  const floorOptions = useMemo(
    () => [...new Set(units.map((unit) => unit.floor))].sort((a, b) => a - b),
    [units],
  );

  const facingOptions = useMemo(
    () =>
      [
        ...new Set(
          units
            .map((unit) => unit.facing)
            .filter((facing): facing is string => facing !== null),
        ),
      ].sort((a, b) => a.localeCompare(b)),
    [units],
  );

  const hasUnspecifiedFacing = useMemo(
    () => units.some((unit) => unit.facing === null),
    [units],
  );

  const liveOf = useCallback(
    (unit: BoardUnit): LiveUnitState =>
      live[unit.id] ?? {
        status: unit.status,
        currentHoldExpiresAt: unit.currentHoldExpiresAt,
        updatedAt: unit.updatedAt,
      },
    [live],
  );

  const hasLiveHolds = useMemo(
    () => units.some((unit) => liveOf(unit).status === "HELD"),
    [units, liveOf],
  );

  // One second is the countdown's resolution, so that is the tick. It runs only
  // while a hold is actually live and the tab is in front: an idle board on a
  // cheap Android should not be waking up once a second for nothing.
  useEffect(() => {
    if (!hasLiveHolds || isPaused) return;
    setNowMs(Date.now() + skewMs);
    const id = setInterval(() => setNowMs(Date.now() + skewMs), 1000);
    return () => clearInterval(id);
  }, [hasLiveHolds, isPaused, skewMs]);

  const towerUnits = useMemo(
    () => units.filter((unit) => (unit.towerId ?? NO_TOWER) === activeTowerKey),
    [units, activeTowerKey],
  );

  const facetUnits = useMemo(
    () => towerUnits.filter((unit) => matchesAttributeFilters(unit, filters)),
    [towerUnits, filters],
  );

  const statusCounts = useMemo(() => {
    const counts = emptyStatusCounts();
    for (const unit of facetUnits) counts[displayStatus(liveOf(unit), nowMs)] += 1;
    return counts;
  }, [facetUnits, liveOf, nowMs]);

  const visibleUnits = useMemo(
    () =>
      filters.statuses.length === 0
        ? facetUnits
        : facetUnits.filter((unit) =>
            filters.statuses.includes(displayStatus(liveOf(unit), nowMs)),
          ),
    [facetUnits, filters.statuses, liveOf, nowMs],
  );

  const floorSections = useMemo(() => {
    const byFloor = new Map<number, BoardUnit[]>();
    for (const unit of visibleUnits) {
      const bucket = byFloor.get(unit.floor);
      if (bucket) bucket.push(unit);
      else byFloor.set(unit.floor, [unit]);
    }
    // Highest floor at the top. The grid is read as a building elevation, not
    // as a table (docs/08-SCREENS.md).
    return [...byFloor.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([floor, floorUnits]) => ({ floor, units: floorUnits }));
  }, [visibleUnits]);

  const handleSelect = useCallback((unitId: string, trigger: HTMLButtonElement) => {
    lastTriggerRef.current = trigger;
    setSelectedUnitId(unitId);
  }, []);

  const handleCloseDrawer = useCallback(() => {
    setSelectedUnitId(null);
    lastTriggerRef.current?.focus();
  }, []);

  const handleReload = useCallback(() => {
    setIsReloading(true);
    router.refresh();
  }, [router]);

  const handleClearFilters = useCallback(() => setFilters(EMPTY_FILTERS), []);

  const selectedUnit = useMemo(
    () => units.find((unit) => unit.id === selectedUnitId) ?? null,
    [units, selectedUnitId],
  );
  const selectedState = selectedUnit ? liveOf(selectedUnit) : null;
  const selectedStatus = selectedState ? displayStatus(selectedState, nowMs) : null;
  const selectedExpiresAt =
    selectedStatus === "HELD" && selectedState ? selectedState.currentHoldExpiresAt : null;
  const selectedRemainingMs =
    selectedExpiresAt === null ? null : Math.max(0, Date.parse(selectedExpiresAt) - nowMs);
  // A unit no delta has touched still carries the holder the server sent. Once
  // a delta has overwritten its state the holder is unknown, because the delta
  // payload has no identity in it.
  const holderIsFromSnapshot = selectedUnit !== null && live[selectedUnit.id] === undefined;

  const activeFilterCount = countActiveFilters(filters);
  const syncedClock = formatIstClock(lastSyncedAt);
  const selectedTowerLabel =
    selectedUnit === null || selectedUnit.towerId === null
      ? null
      : (towers.find((tower) => tower.id === selectedUnit.towerId)?.name ?? null);

  return (
    <div className={styles.board}>
      {/* Fixed within thumb reach on a phone, sticky at the top where there is
          a mouse. At a 60 s poll an associate about to take a hold has to be
          able to force a check rather than wait for the tick -- docs/21-TIER-LIMITS.md
          section 1 is explicit that this button is part of the design, not a
          convenience. */}
      <div className={styles.actionBar}>
        <div className={styles.actionBarInner}>
          <button
            type="button"
            className={styles.refreshButton}
            onClick={refreshNow}
            disabled={isFetching}
          >
            <span aria-hidden="true" className={styles.refreshGlyph}>
              ⟳
            </span>
            {isFetching ? "Checking…" : "Refresh now"}
          </button>
          <div className={styles.syncLine}>
            <span className={styles.syncTime}>Updated {syncedClock} IST</span>
            <span className={styles.syncMode}>
              {isPaused ? "Auto-refresh paused — tab in background" : "Auto-refresh every 60s"}
            </span>
          </div>
        </div>
        {error ? (
          <p className={styles.errorStrip} role="status">
            {error} Still showing data from {syncedClock} IST.
          </p>
        ) : null}
      </div>

      <header className={styles.header}>
        <h1 className={styles.title}>{projectName}</h1>
        <p className={styles.subtitle}>
          {projectCode} · {city} · Live inventory
        </p>
      </header>

      {towerGroups.length > 1 ? (
        <div className={styles.towerBar} role="group" aria-label="Tower">
          {towerGroups.map((group) => (
            <button
              key={group.key}
              type="button"
              className={styles.towerButton}
              aria-pressed={group.key === activeTowerKey}
              onClick={() => setTowerKey(group.key)}
            >
              {group.label}
              <span className={styles.towerCount}>{group.count}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div className={styles.filterHead}>
        <button
          type="button"
          className={styles.filterToggle}
          aria-expanded={filtersOpen}
          aria-controls="board-filter-rail"
          onClick={() => setFiltersOpen((open) => !open)}
        >
          <span aria-hidden="true">{filtersOpen ? "▾" : "▸"}</span> Filters
          {activeFilterCount > 0 ? (
            <span className={styles.filterCount}>{activeFilterCount}</span>
          ) : null}
        </button>
        <p className={styles.summary}>
          <strong>{visibleUnits.length}</strong> of {towerUnits.length} shown ·{" "}
          <strong>{statusCounts.AVAILABLE}</strong> available ·{" "}
          <strong>{statusCounts.HELD}</strong> held
        </p>
      </div>

      <div id="board-filter-rail" hidden={!filtersOpen}>
        <FilterRail
          filters={filters}
          onChange={setFilters}
          onClear={handleClearFilters}
          unitTypes={unitTypeOptions}
          floors={floorOptions}
          facings={facingOptions}
          hasUnspecifiedFacing={hasUnspecifiedFacing}
          statusCounts={statusCounts}
        />
      </div>

      {unknownUnitIds.length > 0 ? (
        <div className={styles.banner} role="status">
          <span>
            {unknownUnitIds.length} unit{unknownUnitIds.length === 1 ? "" : "s"} added since
            this page loaded.
          </span>
          <button
            type="button"
            className={styles.bannerButton}
            onClick={handleReload}
            disabled={isReloading}
          >
            {isReloading ? "Reloading…" : "Reload board"}
          </button>
        </div>
      ) : null}

      <div className={styles.grid}>
        {units.length === 0 ? (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>This project has no units yet.</p>
            <p className={styles.emptyBody}>
              Add towers and units under Projects → Units, then reopen the board.
            </p>
          </div>
        ) : floorSections.length === 0 ? (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>No units match these filters.</p>
            <p className={styles.emptyBody}>
              Widen the floor range, or clear the filters to see the whole tower.
            </p>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={handleClearFilters}
            >
              Clear filters
            </button>
          </div>
        ) : (
          floorSections.map((section) => (
            // role="group" rather than <section>: forty named <section>s would
            // put forty landmarks in a screen reader's landmark list. The floor
            // is also in every tile's accessible name.
            <div
              key={section.floor}
              className={styles.floorRow}
              role="group"
              aria-label={`Floor ${section.floor}`}
            >
              <div className={styles.floorLabel} aria-hidden="true">
                {section.floor}
              </div>
              <div className={styles.floorUnits}>
                {section.units.map((unit) => {
                  const state = liveOf(unit);
                  const status = displayStatus(state, nowMs);
                  const remainingMs =
                    status === "HELD" && state.currentHoldExpiresAt !== null
                      ? Math.max(0, Date.parse(state.currentHoldExpiresAt) - nowMs)
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
                      selected={unit.id === selectedUnitId}
                      onSelect={handleSelect}
                    />
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>

      {selectedUnit && selectedStatus ? (
        <UnitDrawer
          unit={selectedUnit}
          status={selectedStatus}
          towerLabel={selectedTowerLabel}
          expiresAt={selectedExpiresAt}
          countdown={
            selectedRemainingMs === null ? null : formatCountdown(selectedRemainingMs)
          }
          urgent={selectedRemainingMs !== null && selectedRemainingMs <= EXPIRY_WARNING_MS}
          heldByName={holderIsFromSnapshot ? selectedUnit.heldByName : null}
          heldByCode={holderIsFromSnapshot ? selectedUnit.heldByCode : null}
          holderUnknown={selectedStatus === "HELD" && !holderIsFromSnapshot}
          isReloading={isReloading}
          onReload={handleReload}
          onClose={handleCloseDrawer}
        />
      ) : null}
    </div>
  );
}
