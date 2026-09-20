import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/** Route-group loading UI for every back-office page.
 *
 *  Before this existed there was no loading.tsx anywhere in the app, so Next
 *  had no boundary to flush at: every page held the entire response until all
 *  of its queries resolved, and the user watched a blank screen for the whole
 *  time. With this present the shell (sidebar, header) stays on screen and
 *  this skeleton paints immediately on navigation, while the page's own data
 *  streams in behind it. */
export default function BackOfficeLoading() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-6 w-40" />
      <div className="grid gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Card key={i}>
            <CardHeader>
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-3 w-32" />
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-4/5" />
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardContent className="flex flex-col gap-2 py-4">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
