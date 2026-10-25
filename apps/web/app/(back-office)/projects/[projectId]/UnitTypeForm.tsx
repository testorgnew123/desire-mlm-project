import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createUnitTypeAction } from "./actions";

/** Adds a plot type: a code, a name and one area, in square yards. A plot has no
 *  bedrooms, no carpet area and no built-up area. This used to be a flat form
 *  with a flat-or-plot choice in front; only plot types can be created now (the
 *  service refuses a square-foot type), so the choice and the flat fields are
 *  gone, and with nothing left to switch the form needs no client state. */
export function UnitTypeForm({ projectId }: { projectId: string }) {
  return (
    <form action={createUnitTypeAction} className="flex flex-col gap-2 border-t border-border pt-3">
      <input type="hidden" name="projectId" value={projectId} />

      <div className="flex gap-2">
        <Input name="code" placeholder="Code (e.g. PLOT-200)" required />
        <Input name="name" placeholder="Name (e.g. 200 sq yd plot)" required />
      </div>

      <Input name="saleableArea" inputMode="decimal" placeholder="Plot area (sq yd)" required />

      <Button type="submit" size="sm">
        Add plot type
      </Button>
    </form>
  );
}
