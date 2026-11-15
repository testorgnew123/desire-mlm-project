/** What a Server Action returns to an ActionForm instead of redirecting.
 *
 *  Not a redirect, on purpose: in the production build a Server Action that
 *  finished and returned fresh data for the SAME page could leave the screen on
 *  the old data (the POST came back 200 with the new rows inside it, the router
 *  never painted them -- measured on `next start`, not on `next dev`). A result
 *  the client acts on itself, plus `revalidatePath` on the server, paints in one
 *  round trip.
 *
 *  - `message`: shown under the form on success.
 *  - `secret`: a value shown once, after the message (a temporary password). It
 *    travels in this result and nowhere else -- never in a URL, which is how it
 *    used to reach the page -- and the form never reloads the page away while it
 *    is on screen.
 *  - `redirectTo`: where to go next when the save belongs on another page. */
export type ActionResult =
  | { ok: true; message?: string; secret?: string; redirectTo?: string }
  | { ok: false; error: string };
