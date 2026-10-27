// Reads the "plots in this block" rows of the Add block form. Pure, so the rules
// for a half-filled row are tested without a browser.

export interface PlotGroupInput {
  count: number;
  unitTypeId: string;
}

/** `counts[i]` goes with `typeIds[i]` (FormData.getAll keeps document order).
 *  A row with neither a count nor a type is skipped -- an unused extra row is not
 *  an error. A row with one but not the other, or a count that is not a whole
 *  number of 1 or more, throws naming the row, so the message can be shown as is. */
export function parsePlotGroups(counts: readonly string[], typeIds: readonly string[]): PlotGroupInput[] {
  const rows = Math.max(counts.length, typeIds.length);
  const groups: PlotGroupInput[] = [];
  for (let i = 0; i < rows; i += 1) {
    const rawCount = (counts[i] ?? "").trim();
    const unitTypeId = (typeIds[i] ?? "").trim();
    if (rawCount === "" && unitTypeId === "") continue;
    const label = `Size ${i + 1}`;
    if (rawCount === "") throw new Error(`${label}: enter how many plots of this size.`);
    if (unitTypeId === "") throw new Error(`${label}: choose a plot type.`);
    const count = Number(rawCount);
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(`${label}: the number of plots must be a whole number, 1 or more.`);
    }
    groups.push({ count, unitTypeId });
  }
  return groups;
}
