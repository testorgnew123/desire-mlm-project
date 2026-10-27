// How the plots of a new block are numbered.
//
// Dependency-free on purpose. The project page imports this to preview the
// numbering ("A-01 ... A-40") while the count is still being typed, and
// anything that pulls in Prisma must never reach a client bundle. The server
// imports the same function to create the plots, so the preview cannot
// disagree with what gets made.

/** Plots made at block creation cannot be deleted from the UI, so a slipped
 *  finger (400 for 40) is expensive. 500 covers a large block; a bigger one is
 *  a CSV import, which is all-or-nothing and reports every problem it finds. */
export const MAX_PLOTS_PER_BLOCK = 500;

export class PlotCountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlotCountError";
  }
}

/** `<code>-<n>` for n = 1..count, zero-padded to the width of `count` so the
 *  numbers also sort the way they read: A-01 ... A-40, not A-1, A-10, A-2. */
export function plotNumbers(code: string, count: number): string[] {
  const prefix = code.trim();
  if (prefix === "") {
    throw new PlotCountError("A block code is needed to number its plots.");
  }
  if (!Number.isInteger(count) || count < 1 || count > MAX_PLOTS_PER_BLOCK) {
    throw new PlotCountError(
      `Number of plots must be a whole number from 1 to ${MAX_PLOTS_PER_BLOCK}.`,
    );
  }
  const width = String(count).length;
  return Array.from(
    { length: count },
    (_, index) => `${prefix}-${String(index + 1).padStart(width, "0")}`,
  );
}

/** First and last number, or null while the inputs are not yet a valid
 *  combination -- for a preview line that must not throw as someone types. */
export function plotRange(code: string, count: number): { first: string; last: string } | null {
  try {
    const numbers = plotNumbers(code, count);
    return { first: numbers[0]!, last: numbers[numbers.length - 1]! };
  } catch {
    return null;
  }
}

/** One run of plots of the same type inside a block: "10 plots of PLOT-200". */
export interface PlotRow<T = string> {
  count: number;
  type: T;
}

/** The plots of a block made of several sizes. Rows are numbered in the order
 *  given -- the first row gets A-01..., the next carries on -- and the padding
 *  comes from the TOTAL, so the whole block still sorts the way it reads. One
 *  row is exactly what plotNumbers makes. The same type may appear in more than
 *  one row. */
export function plotAssignments<T>(
  code: string,
  rows: ReadonlyArray<PlotRow<T>>,
): Array<{ unitNumber: string; type: T }> {
  if (rows.length === 0) {
    throw new PlotCountError("Add at least one size of plot.");
  }
  let total = 0;
  for (const row of rows) {
    if (!Number.isInteger(row.count) || row.count < 1) {
      throw new PlotCountError("Each size needs a whole number of plots, 1 or more.");
    }
    total += row.count;
  }
  const numbers = plotNumbers(code, total);
  const out: Array<{ unitNumber: string; type: T }> = [];
  let next = 0;
  for (const row of rows) {
    for (let i = 0; i < row.count; i += 1) {
      out.push({ unitNumber: numbers[next]!, type: row.type });
      next += 1;
    }
  }
  return out;
}

/** What a preview line shows for each row -- "A-01 to A-10" -- plus the total,
 *  or null while the inputs are not yet a valid combination. */
export function describePlotRows<T>(
  code: string,
  rows: ReadonlyArray<PlotRow<T>>,
): { total: number; rows: Array<{ type: T; count: number; first: string; last: string }> } | null {
  try {
    const assigned = plotAssignments(code, rows);
    let at = 0;
    return {
      total: assigned.length,
      rows: rows.map((row) => {
        const first = assigned[at]!.unitNumber;
        const last = assigned[at + row.count - 1]!.unitNumber;
        at += row.count;
        return { type: row.type, count: row.count, first, last };
      }),
    };
  } catch {
    return null;
  }
}
