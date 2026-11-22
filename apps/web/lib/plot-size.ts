// Limits on the "Change size" row of the Plots screen.

/** One request resizes at most this many plots. For a whole block, use the CSV
 *  import with "Update plots that already exist". */
export const MAX_PLOTS_PER_SIZE_CHANGE = 50;

/** The longest reason for a new size; the same limit as a reason for blocking. */
export const MAX_SIZE_REASON_LENGTH = 500;
