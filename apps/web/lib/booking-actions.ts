// What the booking page offers the person looking at it, decided in one place so
// it can be tested without rendering the page. The rule used to sit inline in
// bookings/[bookingId]/page.tsx, where a person whose role lacks
// `booking.confirm` simply saw no Confirm button and no word about why.

export interface BookingActionsInput {
  /** BookingStatus. */
  status: string;
  permissions: { has(code: string): boolean };
  /** An unreleased, unexpired hold exists on the plot. Only a draft has one. */
  holdLive: boolean;
}

export interface BookingActions {
  /** The Confirm button is drawn: a draft, and the person may confirm. */
  canConfirm: boolean;
  /** Drawn but not pressable: the hold behind the draft has lapsed. */
  confirmDisabled: boolean;
  /** Why a draft shows this person no Confirm button, or null. */
  confirmNote: string | null;
  canCancel: boolean;
}

export function bookingActions({ status, permissions, holdLive }: BookingActionsInput): BookingActions {
  const isDraft = status === "DRAFT";
  const mayConfirm = permissions.has("booking.confirm");
  return {
    canConfirm: isDraft && mayConfirm,
    confirmDisabled: isDraft && mayConfirm && !holdLive,
    confirmNote:
      isDraft && !mayConfirm
        ? "Only an Admin or a Super Admin can confirm a booking, and your role cannot. If you should be able to, ask a Super Admin to give you the Admin role."
        : null,
    canCancel: status === "CONFIRMED" && permissions.has("booking.cancel"),
  };
}
