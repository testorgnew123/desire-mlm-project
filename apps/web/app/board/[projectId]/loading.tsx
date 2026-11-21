import { Skeleton } from "@/components/ui/skeleton";

/** The board's shape while its plots load, so opening it answers at once. The board is
 *  outside the back-office and phone route groups, so neither group's loading UI
 *  covers it. */
export default function BoardLoading() {
  return (
    <div className="flex min-h-dvh flex-col gap-4 p-4" aria-busy="true">
      <Skeleton className="h-7 w-56" />
      <div className="flex gap-2">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-7 w-20 rounded-full" />
        ))}
      </div>
      <div className="grid grid-cols-4 gap-2 sm:grid-cols-8 lg:grid-cols-12">
        {Array.from({ length: 48 }, (_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    </div>
  );
}
