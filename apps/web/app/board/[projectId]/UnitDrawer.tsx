"use client";

import { useEffect, useId, useRef } from "react";
import type { UnitStatus } from "@desire/db";
import { STATUS_PRESENTATION } from "./status";
import { formatIstDateTime } from "./format";
import type { BoardUnit } from "./types";
import styles from "./board.module.css";

export interface UnitDrawerProps {
  unit: BoardUnit;
  /** Live status, not the snapshot status on `unit`. */
  status: UnitStatus;
  towerLabel: string | null;
  expiresAt: string | null;
  countdown: string | null;
  urgent: boolean;
  heldByName: string | null;
  heldByCode: string | null;
  /** Held, but by someone this page has never been told about -- the delta poll
   *  carries no holder identity. */
  holderUnknown: boolean;
  isReloading: boolean;
  onReload: () => void;
  onClose: () => void;
}

/** The unit drawer of docs/08-SCREENS.md. The live cost sheet, floor plan and
 *  hold button belong here too; they need the ACTIVE price list read and the
 *  POST /units/:id/hold endpoint, neither of which exists yet. Nothing is
 *  stubbed in their place -- an inert Hold button on the board is worse than
 *  no button, because an associate will tap it in front of a customer. */
export function UnitDrawer({
  unit,
  status,
  towerLabel,
  expiresAt,
  countdown,
  urgent,
  heldByName,
  heldByCode,
  holderUnknown,
  isReloading,
  onReload,
  onClose,
}: UnitDrawerProps) {
  const headingId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const presentation = STATUS_PRESENTATION[status];

  // Focus moves into the panel on open and on switching units. Returning focus
  // to the tile is the parent's job -- it is the only thing holding a reference
  // to the trigger.
  useEffect(() => {
    panelRef.current?.focus();
  }, [unit.id]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <>
      <div className={styles.backdrop} aria-hidden="true" onClick={onClose} />
      <div
        ref={panelRef}
        className={styles.drawer}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
      >
        <div className={styles.drawerHeader}>
          <div>
            <h2 id={headingId} className={styles.drawerTitle}>
              {unit.unitNumber}
            </h2>
            <span
              className={[styles.statusBadge, styles[presentation.tone]]
                .filter(Boolean)
                .join(" ")}
            >
              <span aria-hidden="true">{presentation.glyph}</span> {presentation.long}
            </span>
          </div>
          <button
            type="button"
            className={styles.drawerClose}
            onClick={onClose}
            aria-label="Close unit details"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>

        <div className={styles.drawerBody}>
          {status === "HELD" ? (
            <section
              className={[styles.holdBlock, urgent && styles.holdBlockUrgent]
                .filter(Boolean)
                .join(" ")}
            >
              <h3 className={styles.detailHeading}>Hold</h3>
              <p className={styles.holdCountdown}>
                {countdown ?? "00:00"}
                <span className={styles.holdCountdownUnit}> left</span>
              </p>
              {expiresAt ? (
                <p className={styles.holdMeta}>Expires {formatIstDateTime(expiresAt)} IST</p>
              ) : null}
              {heldByName ? (
                <p className={styles.holdMeta}>
                  Held by {heldByName}
                  {heldByCode ? ` (${heldByCode})` : ""}
                </p>
              ) : holderUnknown ? (
                <p className={styles.holdMeta}>
                  Taken since this page loaded.{" "}
                  <button
                    type="button"
                    className={styles.inlineButton}
                    onClick={onReload}
                    disabled={isReloading}
                  >
                    {isReloading ? "Reloading…" : "Reload to see who"}
                  </button>
                </p>
              ) : null}
            </section>
          ) : null}

          {status === "BLOCKED" ? (
            <section className={styles.blockBlock}>
              <h3 className={styles.detailHeading}>Blocked</h3>
              <p className={styles.blockReason}>
                {unit.blockReason ?? "No reason recorded."}
              </p>
            </section>
          ) : null}

          <h3 className={styles.detailHeading}>Unit</h3>
          <dl className={styles.detailList}>
            <div className={styles.detailRow}>
              <dt className={styles.detailTerm}>Tower</dt>
              <dd className={styles.detailValue}>{towerLabel ?? "Not assigned"}</dd>
            </div>
            <div className={styles.detailRow}>
              <dt className={styles.detailTerm}>Floor</dt>
              <dd className={styles.detailValue}>{unit.floor}</dd>
            </div>
            <div className={styles.detailRow}>
              <dt className={styles.detailTerm}>Type</dt>
              <dd className={styles.detailValue}>
                {unit.unitTypeName} ({unit.unitTypeCode})
                {unit.bedrooms !== null ? ` · ${unit.bedrooms} BHK` : ""}
              </dd>
            </div>
            <div className={styles.detailRow}>
              <dt className={styles.detailTerm}>Facing</dt>
              <dd className={styles.detailValue}>{unit.facing ?? "Not recorded"}</dd>
            </div>
            <div className={styles.detailRow}>
              <dt className={styles.detailTerm}>PLC</dt>
              <dd className={styles.detailValue}>
                {unit.plcTags.length > 0 ? unit.plcTags.join(", ") : "None"}
              </dd>
            </div>
          </dl>

          {/* Every area is labelled with which area it is. A bare "1,250 sq ft"
              is the most expensive mistake in this domain -- carpet against a
              saleable rate misprices a unit by roughly 35%
              (docs/19-GLOSSARY.md, docs/08-SCREENS.md). Carpet is first because
              it is the RERA-mandated figure that must appear on every
              customer-facing screen. */}
          <h3 className={styles.detailHeading}>Area</h3>
          <dl className={styles.detailList}>
            <div className={styles.detailRow}>
              <dt className={styles.detailTerm}>
                Carpet <span className={styles.tag}>RERA</span>
              </dt>
              <dd className={styles.detailValue}>{unit.carpetArea} sq ft (carpet)</dd>
            </div>
            <div className={styles.detailRow}>
              <dt className={styles.detailTerm}>Built-up</dt>
              <dd className={styles.detailValue}>{unit.builtUpArea} sq ft (built-up)</dd>
            </div>
            <div className={styles.detailRow}>
              <dt className={styles.detailTerm}>Saleable</dt>
              <dd className={styles.detailValue}>{unit.saleableArea} sq ft (saleable)</dd>
            </div>
          </dl>
        </div>
      </div>
    </>
  );
}
