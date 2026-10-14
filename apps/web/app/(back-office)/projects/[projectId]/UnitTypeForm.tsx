"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createUnitTypeAction } from "./actions";

const SELECT_CLASS = "h-9 rounded-md border border-border bg-background px-2 text-sm";

/** A unit type is either a flat (carpet, built-up and saleable area, in sq ft)
 *  or a plot (one area, in sq yd). The first version of this form was a flat
 *  form with a basis dropdown bolted on: it still said "3BHK", asked for
 *  bedrooms, and printed "(? BHK)" for every plot. Here the choice comes first
 *  and the rest follows it -- a plot has no bedrooms, no carpet and no built-up
 *  area, so those fields do not exist for it rather than sitting there empty.
 *
 *  createUnitType still decides which basis may carry which areas; this only
 *  stops the form inviting the wrong ones. */
export function UnitTypeForm({ projectId }: { projectId: string }) {
  const [basis, setBasis] = useState<"SQFT" | "SQYD">("SQFT");
  const isPlot = basis === "SQYD";

  return (
    <form action={createUnitTypeAction} className="flex flex-col gap-2 border-t border-border pt-3">
      <input type="hidden" name="projectId" value={projectId} />

      <select
        name="areaBasis"
        aria-label="What kind of unit"
        value={basis}
        onChange={(event) => setBasis(event.target.value === "SQYD" ? "SQYD" : "SQFT")}
        className={SELECT_CLASS}
      >
        <option value="SQFT">Flat / apartment (area in sq ft)</option>
        <option value="SQYD">Plot (area in sq yd)</option>
      </select>

      <div className="flex gap-2">
        <Input
          name="code"
          placeholder={isPlot ? "Code (e.g. PLOT-200)" : "Code (e.g. 3BHK)"}
          required
        />
        <Input
          name="name"
          placeholder={isPlot ? "Name (e.g. 200 sq yd plot)" : "Name (e.g. 3 BHK premium)"}
          required
        />
      </div>

      {isPlot ? (
        <Input name="saleableArea" inputMode="decimal" placeholder="Plot area (sq yd)" required />
      ) : (
        <>
          <div className="flex gap-2">
            <Input name="bedrooms" type="number" min="0" placeholder="Bedrooms" />
            <Input name="carpetArea" inputMode="decimal" placeholder="Carpet area (sq ft)" required />
          </div>
          <div className="flex gap-2">
            <Input
              name="builtUpArea"
              inputMode="decimal"
              placeholder="Built-up area (sq ft)"
              required
            />
            <Input
              name="saleableArea"
              inputMode="decimal"
              placeholder="Saleable area (sq ft)"
              required
            />
          </div>
        </>
      )}

      <Button type="submit" size="sm">
        {isPlot ? "Add plot type" : "Add flat type"}
      </Button>
    </form>
  );
}
