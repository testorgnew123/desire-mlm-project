"use client";

import { useEffect } from "react";

/** Wakes the database while a person types their password. Neon's free tier
 *  suspends it after five idle minutes, and the first query after that was
 *  measured at 0.9-4.6 s (docs/22 round six). One `SELECT 1`, fetched when the
 *  sign-in page opens, spends that time behind the typing instead of behind the
 *  Sign in button. */
export function WarmUp() {
  useEffect(() => {
    fetch("/api/health", { cache: "no-store" }).catch(() => undefined);
  }, []);
  return null;
}
