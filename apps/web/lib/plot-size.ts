// The sizes the "New size" list on the Plots screen offers, and what it accepts
// back. Pure, so both are tested without a browser.

/** One request resizes at most this many plots. For a whole block, use the CSV
 *  import with "Update plots that already exist". */
export const MAX_PLOTS_PER_SIZE_CHANGE = 50;

/** The longest reason for a new size; the same limit as a reason for blocking. */
export const MAX_SIZE_REASON_LENGTH = 500;

/** The column is Decimal(10,2): eight whole digits and at most two decimals. */
const SIZE = /^\d{1,8}(\.\d{1,2})?$/;

/** "210" or "210.5" -> a fixed-point string for the service, which takes areas
 *  as strings and never as floats. Blank, zero, negative, lettered, comma'd or
 *  three-decimal entries throw a message that can be shown as it is. */
export function parsePlotSize(raw: string): string {
  const typed = raw.trim();
  if (!SIZE.test(typed) || Number(typed) <= 0) {
    throw new Error("Enter the new size in square yards as a plain number, such as 210 or 210.5 (at most two decimals).");
  }
  // "0210" is 210; say 210 back.
  return typed.replace(/^0+(?=\d)/, "");
}

/** The sizes the "New size" list offers: each once, smallest first. Callers pass
 *  fixed-point strings ("200.00"), so equal sizes are equal strings and what comes
 *  back is what parsePlotSize takes. */
export function listPlotSizes(sizes: readonly string[]): string[] {
  return [...new Set(sizes)].sort((a, b) => Number(a) - Number(b));
}
