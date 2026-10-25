"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";

/** Last-resort boundary. Next hides the real message in production, so this says
 *  only what a person can act on; the digest is what to quote when reporting it. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 p-6 text-center">
      <h1 className="text-lg font-semibold">Something went wrong</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        The page could not be shown. Try again, and if it keeps happening quote this reference:{" "}
        <span className="font-mono">{error.digest ?? "none"}</span>
      </p>
      <div className="flex gap-2">
        <Button onClick={reset}>Try again</Button>
        <Button variant="outline" nativeButton={false} render={<Link href="/" />}>
          Start page
        </Button>
      </div>
    </main>
  );
}
