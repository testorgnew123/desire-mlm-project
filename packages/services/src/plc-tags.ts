// How a PLC tag ("CORNER", "PARK_FACING") is written. Dependency-free so the
// importer, createUnit, updateUnit and the corner-marking service all use the one
// rule, and the Add plot form can import it without pulling in Prisma.
//
// One spelling matters because a tag is matched by exact text against the price
// list's charges: "corner" on a plot and "CORNER" on the rate would leave the
// plot unpriced, and "CORNER" written twice would charge the premium twice.

export const MAX_PLC_TAG_LENGTH = 30;

export class PlcTagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlcTagError";
  }
}

/** Trimmed, upper-cased, runs of spaces and hyphens turned into one underscore:
 *  " corner " -> "CORNER", "park facing" -> "PARK_FACING". Throws PlcTagError for
 *  anything that is then not 1..30 of A-Z, 0-9 and underscore. */
export function normalizePlcTag(raw: string): string {
  const tag = raw.trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (!new RegExp(`^[A-Z0-9_]{1,${MAX_PLC_TAG_LENGTH}}$`).test(tag)) {
    throw new PlcTagError(
      `"${raw.trim()}" is not a valid tag: use letters, digits and underscores, up to ${MAX_PLC_TAG_LENGTH} characters.`,
    );
  }
  return tag;
}

/** A tag list written once each, in first-seen order. */
export function normalizePlcTags(raw: readonly string[]): string[] {
  return [...new Set(raw.map(normalizePlcTag))];
}
