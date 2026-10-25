import Link from "next/link";
import { Button } from "@/components/ui/button";

/** Also what a switched-off page resolves to: next.config.ts rewrites those to a
 *  path that does not exist, so a disabled feature and a typo look the same. */
export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-sm text-muted-foreground">404</p>
      <h1 className="text-lg font-semibold">This page is not available</h1>
      <Button nativeButton={false} render={<Link href="/" />}>
        Go to the start page
      </Button>
    </main>
  );
}
