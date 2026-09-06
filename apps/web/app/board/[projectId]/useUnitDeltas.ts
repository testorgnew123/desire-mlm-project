"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DeltaResponse, LiveUnitState } from "./types";

/** 60 seconds, NOT the 10-15 s of docs/06-INVENTORY-SPEC.md section 6.
 *  docs/21-TIER-LIMITS.md section 1 supersedes it: at 12 s, ten associates with
 *  the board open for an hour a day spend 78,000 of the 125,000 monthly Netlify
 *  invocations on polling alone. 60 s is the documented target and leaves room
 *  for the rest of the app. */
const POLL_INTERVAL_MS = 60_000;

/** Returning to a backgrounded tab on a phone fires visibilitychange AND focus.
 *  Without a floor, one resume costs two invocations. */
const MIN_AUTO_REFETCH_GAP_MS = 5_000;

/** A stalled request on 4G must not wedge the in-flight latch, or the manual
 *  refresh button stops working exactly when it is needed. */
const REQUEST_TIMEOUT_MS = 15_000;

type FetchMode = "auto" | "manual";

export interface UseUnitDeltasParams {
  projectId: string;
  /** serverTime of the snapshot the page was rendered from. Doubles as the
   *  first `?since` and as the seed for the clock-offset estimate. */
  initialServerTime: string;
  /** Ids present in the catalogue, so a delta for a unit added after page load
   *  can be reported rather than silently dropped. */
  knownUnitIds: ReadonlySet<string>;
}

export interface UseUnitDeltasResult {
  /** Overlay, keyed by unit id. Absent means "unchanged since page load". */
  live: Record<string, LiveUnitState>;
  /** serverClock - deviceClock, in ms. Added to Date.now() for every countdown. */
  skewMs: number;
  /** serverTime of the last successful sync, ISO 8601. */
  lastSyncedAt: string;
  isFetching: boolean;
  isPaused: boolean;
  error: string | null;
  unknownUnitIds: string[];
  refreshNow: () => void;
}

export function useUnitDeltas({
  projectId,
  initialServerTime,
  knownUnitIds,
}: UseUnitDeltasParams): UseUnitDeltasResult {
  const [live, setLive] = useState<Record<string, LiveUnitState>>({});
  const [skewMs, setSkewMs] = useState(0);
  const [lastSyncedAt, setLastSyncedAt] = useState(initialServerTime);
  const [isFetching, setIsFetching] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unknownUnitIds, setUnknownUnitIds] = useState<string[]>([]);

  const sinceRef = useRef(initialServerTime);
  const seedRef = useRef(initialServerTime);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef(false);
  const lastFetchStartedAtRef = useRef(0);
  const mountedRef = useRef(true);
  const runRef = useRef<(mode: FetchMode) => void>(() => {});

  // Latest-value ref rather than a hook dependency: the catalogue changes only
  // on a full reload, and rebuilding the fetch loop for it would drop the timer.
  const knownIdsRef = useRef(knownUnitIds);
  knownIdsRef.current = knownUnitIds;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Seed the clock offset from the snapshot the page was rendered with. A
  // device clock minutes out would otherwise make every countdown wrong, and a
  // countdown an associate cannot trust is worse than no countdown at all
  // (docs/08-SCREENS.md). This estimate is short by the page's transit time,
  // which understates the time remaining -- the safe direction to be wrong in.
  useEffect(() => {
    setSkewMs(Date.parse(initialServerTime) - Date.now());
  }, [initialServerTime]);

  // A full reload (router.refresh, after units were added) hands down a fresh
  // catalogue and a fresh serverTime. The overlay describes the OLD snapshot,
  // so it is discarded rather than merged.
  useEffect(() => {
    if (seedRef.current === initialServerTime) return;
    seedRef.current = initialServerTime;
    sinceRef.current = initialServerTime;
    setLive({});
    setUnknownUnitIds([]);
    setLastSyncedAt(initialServerTime);
    setError(null);
  }, [initialServerTime]);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Rescheduled after each attempt settles rather than run on a fixed interval,
  // so a manual refresh also resets the clock: two polls 3 seconds apart is two
  // invocations for one piece of information.
  const schedule = useCallback(() => {
    clearTimer();
    timerRef.current = setTimeout(() => {
      runRef.current("auto");
    }, POLL_INTERVAL_MS);
  }, [clearTimer]);

  const run = useCallback(
    async (mode: FetchMode) => {
      if (inFlightRef.current) return;
      if (document.visibilityState === "hidden") {
        clearTimer();
        return;
      }

      const startedAt = Date.now();
      if (mode === "auto" && startedAt - lastFetchStartedAtRef.current < MIN_AUTO_REFETCH_GAP_MS) {
        schedule();
        return;
      }

      inFlightRef.current = true;
      lastFetchStartedAtRef.current = startedAt;
      setIsFetching(true);

      const controller = new AbortController();
      abortRef.current = controller;
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const url =
          `/api/v1/projects/${encodeURIComponent(projectId)}/units/deltas` +
          `?since=${encodeURIComponent(sinceRef.current)}`;
        const response = await fetch(url, {
          signal: controller.signal,
          credentials: "same-origin",
          cache: "no-store",
          headers: { accept: "application/json" },
        });
        if (!response.ok) {
          throw new Error(`Refresh failed (HTTP ${response.status}).`);
        }
        const body = (await response.json()) as DeltaResponse;
        const receivedAt = Date.now();
        if (!mountedRef.current) return;

        // The polling contract, stated in the route handler: send the server's
        // own serverTime back verbatim. A client clock running fast would skip
        // changes; running slow it would refetch the same rows forever.
        sinceRef.current = body.serverTime;
        setSkewMs(Date.parse(body.serverTime) - receivedAt);
        setLastSyncedAt(body.serverTime);
        setError(null);

        if (body.units.length > 0) {
          setLive((previous) => {
            const next = { ...previous };
            for (const unit of body.units) {
              next[unit.id] = {
                status: unit.status,
                currentHoldExpiresAt: unit.currentHoldExpiresAt,
                updatedAt: unit.updatedAt,
              };
            }
            return next;
          });

          // A delta can name a unit created after this page loaded. Its floor
          // and tower are unknown here, so it cannot be placed on the
          // elevation -- surface it and let the associate reload.
          const unseen = body.units
            .filter((unit) => !knownIdsRef.current.has(unit.id))
            .map((unit) => unit.id);
          if (unseen.length > 0) {
            setUnknownUnitIds((previous) => [...new Set([...previous, ...unseen])]);
          }
        }
      } catch (caught) {
        if (!mountedRef.current) return;
        setError(
          controller.signal.aborted
            ? "Refresh timed out."
            : caught instanceof Error
              ? caught.message
              : "Refresh failed.",
        );
      } finally {
        clearTimeout(timeoutId);
        inFlightRef.current = false;
        abortRef.current = null;
        if (mountedRef.current) {
          setIsFetching(false);
          if (document.visibilityState === "visible") schedule();
        }
      }
    },
    [projectId, clearTimer, schedule],
  );
  runRef.current = run;

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        // Mandatory, not an optimisation (docs/21-TIER-LIMITS.md section 1): a
        // background tab polling all day is a line item against a hard monthly
        // invocation cap. An already-issued request is left to finish -- it is
        // paid for -- but nothing new is scheduled.
        clearTimer();
        setIsPaused(true);
      } else {
        setIsPaused(false);
        runRef.current("auto");
      }
    };

    // Same-tab window focus: the tab never went hidden, so visibilitychange
    // does not fire, but the associate has just come back to the board.
    const onFocus = () => {
      if (document.visibilityState === "visible") runRef.current("auto");
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onFocus);

    if (document.visibilityState === "visible") {
      // No immediate fetch: the server snapshot this page rendered with is
      // already current, so the first poll is one interval away. One
      // invocation saved on every board open.
      schedule();
    } else {
      setIsPaused(true);
    }

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onFocus);
      clearTimer();
      abortRef.current?.abort();
    };
  }, [clearTimer, schedule]);

  const refreshNow = useCallback(() => {
    runRef.current("manual");
  }, []);

  return {
    live,
    skewMs,
    lastSyncedAt,
    isFetching,
    isPaused,
    error,
    unknownUnitIds,
    refreshNow,
  };
}
