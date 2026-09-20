import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/** Route-group loading UI for the associate PWA. Same reasoning as the
 *  back-office one: without a loading boundary the whole page waits on its
 *  slowest query before anything paints, which is worst on exactly the
 *  device this shell targets (a phone on 4G). */
export default function PwaLoading() {
  return (
    <div className="flex flex-col gap-4 p-4">
      <Skeleton className="h-6 w-32" />
      {[0, 1, 2].map((i) => (
        <Card key={i}>
          <CardHeader>
            <Skeleton className="h-5 w-28" />
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-2/3" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
