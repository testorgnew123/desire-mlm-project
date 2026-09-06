"use client";

import { useId } from "react";
import type { UnitStatus } from "@desire/db";
import { STATUS_PRESENTATION, UNIT_STATUS_ORDER } from "./status";
import { ANY, UNSPECIFIED, type BoardFilters } from "./filters";
import styles from "./board.module.css";

export interface FilterRailProps {
  filters: BoardFilters;
  onChange: (next: BoardFilters) => void;
  onClear: () => void;
  unitTypes: Array<{ id: string; code: string; name: string }>;
  floors: number[];
  facings: string[];
  hasUnspecifiedFacing: boolean;
  statusCounts: Record<UnitStatus, number>;
}

export function FilterRail({
  filters,
  onChange,
  onClear,
  unitTypes,
  floors,
  facings,
  hasUnspecifiedFacing,
  statusCounts,
}: FilterRailProps) {
  const id = useId();

  const toggleStatus = (status: UnitStatus) => {
    onChange({
      ...filters,
      statuses: filters.statuses.includes(status)
        ? filters.statuses.filter((existing) => existing !== status)
        : [...filters.statuses, status],
    });
  };

  return (
    <div className={styles.rail}>
      <div className={styles.fieldGrid}>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor={`${id}-type`}>
            Unit type
          </label>
          <select
            id={`${id}-type`}
            className={styles.select}
            value={filters.unitTypeId}
            onChange={(event) => onChange({ ...filters, unitTypeId: event.target.value })}
          >
            <option value={ANY}>All types</option>
            {unitTypes.map((type) => (
              <option key={type.id} value={type.id}>
                {type.code} — {type.name}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor={`${id}-facing`}>
            Facing
          </label>
          <select
            id={`${id}-facing`}
            className={styles.select}
            value={filters.facing}
            onChange={(event) => onChange({ ...filters, facing: event.target.value })}
          >
            <option value={ANY}>Any facing</option>
            {facings.map((facing) => (
              <option key={facing} value={facing}>
                {facing}
              </option>
            ))}
            {hasUnspecifiedFacing ? <option value={UNSPECIFIED}>Not recorded</option> : null}
          </select>
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor={`${id}-floor-min`}>
            Floor from
          </label>
          <select
            id={`${id}-floor-min`}
            className={styles.select}
            value={filters.floorMin === null ? "" : String(filters.floorMin)}
            onChange={(event) =>
              onChange({
                ...filters,
                floorMin: event.target.value === "" ? null : Number(event.target.value),
              })
            }
          >
            <option value="">Lowest</option>
            {floors.map((floor) => (
              <option key={floor} value={floor}>
                {floor}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor={`${id}-floor-max`}>
            Floor to
          </label>
          <select
            id={`${id}-floor-max`}
            className={styles.select}
            value={filters.floorMax === null ? "" : String(filters.floorMax)}
            onChange={(event) =>
              onChange({
                ...filters,
                floorMax: event.target.value === "" ? null : Number(event.target.value),
              })
            }
          >
            <option value="">Highest</option>
            {floors.map((floor) => (
              <option key={floor} value={floor}>
                {floor}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* These chips are also the legend. Each carries the same swatch, glyph
          and wording the tiles use, so the key to the grid is never a separate
          thing that can drift out of sync with it. */}
      <fieldset className={styles.chipFieldset}>
        <legend className={styles.fieldLabel}>Availability</legend>
        <div className={styles.chipRow}>
          <button
            type="button"
            className={[styles.chip, styles.chipAll].join(" ")}
            aria-pressed={filters.statuses.length === 0}
            onClick={() => onChange({ ...filters, statuses: [] })}
          >
            <span className={styles.chipLabel}>All</span>
          </button>
          {UNIT_STATUS_ORDER.map((status) => {
            const presentation = STATUS_PRESENTATION[status];
            return (
              <button
                key={status}
                type="button"
                className={[styles.chip, styles[presentation.tone]].filter(Boolean).join(" ")}
                aria-pressed={filters.statuses.includes(status)}
                onClick={() => toggleStatus(status)}
              >
                <span className={styles.chipSwatch} aria-hidden="true">
                  {presentation.glyph}
                </span>
                <span className={styles.chipLabel}>{presentation.long}</span>
                <span className={styles.chipCount}>{statusCounts[status]}</span>
              </button>
            );
          })}
        </div>
      </fieldset>

      <button type="button" className={styles.secondaryButton} onClick={onClear}>
        Clear filters
      </button>
    </div>
  );
}
