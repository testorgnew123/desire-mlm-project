import type { LucideIcon } from "lucide-react";
import { cn } from "cn";

/** Replaces the plain `<p className="text-muted-foreground">Nothing yet.</p>`
 *  fallback that was scattered across every list/widget in the app -- one
 *  small icon + message instead of bare text, same information, better to
 *  actually look at. */
export function EmptyState({
  icon: Icon,
  message,
  className,
}: {
  icon: LucideIcon;
  message: string;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center gap-2 py-6 text-center", className)}>
      <Icon className="size-8 text-muted-foreground/50" strokeWidth={1.5} />
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  );
}
