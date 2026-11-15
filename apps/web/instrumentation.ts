// Runs once when the server starts.
//
// Booking mail after the response. A booking waiting, confirmed or cancelled sends
// mail, and by default the person who did it waits for the mail server (up to 4 s):
// on a serverless function nothing is guaranteed to run once the response has gone.
// With BOOKING_MAIL_AFTER_RESPONSE=1 the mail is handed to Next's `after()` instead
// and nobody waits for it. Off by default because it only works where the host keeps
// the function alive until `after()` has finished: switch it on, then confirm on a
// deploy preview that a booking's emails still arrive. Off again if they do not.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.BOOKING_MAIL_AFTER_RESPONSE !== "1") return;

  const [{ after }, { setBookingMailScheduler }] = await Promise.all([
    import("next/server"),
    import("@desire/services/booking-mail"),
  ]);
  setBookingMailScheduler((task) => after(task));
}
