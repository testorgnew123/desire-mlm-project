"use client";

import { useEffect } from "react";

/** Registers public/sw.js -- separate client component so the root layout
 *  itself stays a server component. Fails silently (console only) on
 *  browsers without service worker support or when registration itself
 *  errors; offline reads are a progressive enhancement, never a hard
 *  requirement to use the app online. */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch((error) => {
      console.error("Service worker registration failed:", error);
    });
  }, []);

  return null;
}
