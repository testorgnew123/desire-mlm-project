// What to call a Tower row. The table is named Tower for historical reasons
// (renaming it would touch every relation and both boards for no behaviour), but
// a row of kind BLOCK is a plotted block of land, and calling it a tower in front
// of a developer who just created a block is simply wrong.
//
// Client-safe on purpose: no Prisma import, so the board's client components can
// use it. The kind arrives as a plain string union.

export type GroupKind = "TOWER" | "BLOCK";

export function groupNoun(kind: GroupKind | null | undefined): "Tower" | "Block" {
  return kind === "BLOCK" ? "Block" : "Tower";
}

/** "2 towers, 1 block", or a plain statement while there is nothing yet. */
export function describeGroupCounts(towers: number, blocks: number): string {
  const parts: string[] = [];
  if (towers > 0) parts.push(`${towers} ${towers === 1 ? "tower" : "towers"}`);
  if (blocks > 0) parts.push(`${blocks} ${blocks === 1 ? "block" : "blocks"}`);
  return parts.length > 0 ? parts.join(", ") : "None yet";
}
