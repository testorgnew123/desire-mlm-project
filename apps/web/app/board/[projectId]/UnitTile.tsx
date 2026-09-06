"use client";

import { memo } from "react";
import type { UnitStatus } from "@desire/db";
import { STATUS_PRESENTATION } from "./status";
import styles from "./board.module.css";

export interface UnitTileProps {
  unitId: string;
  unitNumber: string;
  floor: number;
  unitTypeCode: string;
  status: UnitStatus;
  /** mm:ss (or h:mm:ss) while a hold is live, null otherwise. */
  countdown: string | null;
  /** Whole minutes left, for the accessible name. Deliberately coarser than the
   *  visible countdown: a name that changed every second would make a screen
   *  reader unusable on this grid. */
  remainingMinutes: number | null;
  urgent: boolean;
  selected: boolean;
  onSelect: (unitId: string, trigger: HTMLButtonElement) => void;
}

/** Every prop is a primitive or a stable callback on purpose. The parent
 *  re-renders once a second while any hold is live; memo can only bail out for
 *  the other several hundred tiles if their props compare equal. */
function UnitTileComponent({
  unitId,
  unitNumber,
  floor,
  unitTypeCode,
  status,
  countdown,
  remainingMinutes,
  urgent,
  selected,
  onSelect,
}: UnitTileProps) {
  const presentation = STATUS_PRESENTATION[status];

  const accessibleName = [
    `Unit ${unitNumber}`,
    `floor ${floor}`,
    unitTypeCode,
    presentation.long,
    remainingMinutes === null
      ? null
      : remainingMinutes < 1
        ? "expires in under a minute"
        : `expires in ${remainingMinutes} minute${remainingMinutes === 1 ? "" : "s"}`,
  ]
    .filter((part) => part !== null)
    .join(", ");

  return (
    <button
      type="button"
      className={[
        styles.tile,
        styles[presentation.tone],
        urgent && styles.tileUrgent,
        selected && styles.tileSelected,
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label={accessibleName}
      aria-haspopup="dialog"
      onClick={(event) => onSelect(unitId, event.currentTarget)}
    >
      <span className={styles.tileNumber}>{unitNumber}</span>
      <span className={styles.tileStatus}>
        <span aria-hidden="true" className={styles.tileGlyph}>
          {presentation.glyph}
        </span>
        {presentation.short}
      </span>
      {/* Third line is always present so tiles stay a uniform height: the
          countdown when held, the unit type otherwise. */}
      <span className={styles.tileFoot}>
        {countdown === null ? unitTypeCode : urgent ? `! ${countdown}` : countdown}
      </span>
    </button>
  );
}

export const UnitTile = memo(UnitTileComponent);
