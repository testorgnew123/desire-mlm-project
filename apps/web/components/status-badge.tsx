import { Badge } from "@/components/ui/badge";
import type { BadgeTone } from "@/lib/status-tone";

/** Renders a domain status as a colored Badge, always with the label text
 *  itself (docs/12-NFR.md: "no colour-only status") -- the tone comes from
 *  the per-enum mapping functions in lib/status-tone.ts, never guessed here. */
export function StatusBadge({ status, tone }: { status: string; tone: BadgeTone }) {
  return (
    <Badge variant={tone} className="font-normal tabular-nums">
      {status.replaceAll("_", " ")}
    </Badge>
  );
}
