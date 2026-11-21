import { Skeleton } from "@/components/ui/skeleton";

/** The plot grid's shape (title, block tabs, tiles) while its plots load, so tapping a
 *  project answers at once instead of showing the generic card placeholder. */
export default function InventoryGridLoading() {
  return (
    <div className="flex flex-col" aria-busy="true">
      <div className="flex flex-col gap-2 border-b border-border p-4">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-3 w-20" />
      </div>
      <div className="flex gap-2 overflow-hidden border-b border-border px-4 py-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-6 w-20 shrink-0 rounded-full" />
        ))}
      </div>
      <div className="grid grid-cols-4 gap-2 p-4">
        {Array.from({ length: 24 }, (_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    </div>
  );
}
