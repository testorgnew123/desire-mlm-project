"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Renders nothing. On mount, if the server snapshot this page was rendered
 *  with is older than `maxAgeMs`, calls router.refresh().
 *
 *  Why this exists: next.config.ts sets `staleTimes.dynamic` to 60 s, and
 *  every nav link is fully prefetched, so a screen can be painted from the
 *  client router cache without the server being consulted at all. That is the
 *  whole point -- a cache hit costs 0 ms against a ~450 ms India->Ohio round
 *  trip -- but it is wrong on the handful of screens where two people can act
 *  on the SAME row. A minute-old receipt verification queue invites verifying
 *  a receipt a colleague has already cleared. The service layer still rejects
 *  the second action, so this is not a correctness hole; it is the difference
 *  between an up-to-date list and a confusing error.
 *
 *  Generalised from the inventory board, which has carried its own copy of
 *  this rule since the cache was introduced
 *  (app/board/[projectId]/InventoryBoard.tsx -- it refreshes when its snapshot
 *  is older than 5 s). The board keeps its own version because it is wired to
 *  the delta-poll hook rather than a plain refresh.
 *
 *  `renderedAt` must be produced during the SERVER render (`new
 *  Date().toISOString()` in the page), not in this component -- it dates the
 *  snapshot, not the mount. A genuinely fresh render therefore spends no extra
 *  invocation, which matters on a tier metered by them. */
export function RefreshIfStale({
  renderedAt,
  maxAgeMs = 10_000,
}: {
  renderedAt: string;
  maxAgeMs?: number;
}) {
  const router = useRouter();

  useEffect(() => {
    if (Date.now() - Date.parse(renderedAt) > maxAgeMs) router.refresh();
    // renderedAt identifies the snapshot: a new value means a real re-render,
    // which is exactly when this should be reconsidered.
  }, [renderedAt, maxAgeMs, router]);

  return null;
}
