"use client";

import { useEffect } from "react";

/** Wakes the server while the person types their password.
 *
 *  The first request after a quiet spell pays for waking the function and the
 *  database (2-9 s measured on the live site, and the keep-warm schedule only covers
 *  weekday working hours). The sign-in itself would be that first request. This sends
 *  the cheapest request there is, the health check (one `SELECT 1`, no session), the
 *  moment the form appears, so by the time Sign in is pressed both are awake. The
 *  answer is not read and a failure changes nothing. */
export function WarmUp() {
  useEffect(() => {
    fetch("/api/health", { cache: "no-store", credentials: "omit" }).catch(() => undefined);
  }, []);
  return null;
}
