// GET /bookings/:id (docs/07-API.md). Gated on the new booking.read
// permission (packages/db/src/permission-matrix.ts) -- added this slice,
// since no read permission for bookings existed before it. Scope split
// mirrors lead.read exactly: ASSOCIATE sees their own, TEAM_LEAD sees their
// own + downline (resolved through the ONE existing scope resolver,
// getAccessibleAssociateIds in rbac.ts -- never hand-rolled), everyone else
// with the permission sees all.
import { getPrismaClient } from "@desire/db";
import { SessionInvalidError, validateSession } from "@desire/services/auth";
import { ForbiddenError, assertPermission, getAccessibleAssociateIds } from "@desire/services/rbac";
import { getBooking, type Booking, type CostSheetLine } from "@desire/services/bookings";

export const dynamic = "force-dynamic";

const SESSION_COOKIE_NAME = "desire_session";
const SCOPED_ROLE_CODES = new Set(["ASSOCIATE", "TEAM_LEAD"]);

function problemResponse(params: {
  status: number;
  type: string;
  title: string;
  detail: string;
  instance: string;
}): Response {
  return Response.json(
    {
      type: `https://docs.internal/errors/${params.type}`,
      title: params.title,
      status: params.status,
      detail: params.detail,
      instance: params.instance,
    },
    { status: params.status, headers: { "content-type": "application/problem+json" } },
  );
}

function readSessionToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization !== null) {
    const separator = authorization.indexOf(" ");
    if (separator !== -1 && authorization.slice(0, separator).toLowerCase() === "bearer") {
      const token = authorization.slice(separator + 1).trim();
      if (token !== "") return token;
    }
  }

  const cookieHeader = request.headers.get("cookie");
  if (cookieHeader === null) return null;
  for (const pair of cookieHeader.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1) continue;
    if (pair.slice(0, separator).trim() !== SESSION_COOKIE_NAME) continue;
    const value = pair.slice(separator + 1).trim();
    return value === "" ? null : value;
  }
  return null;
}

function serializeBooking(booking: Booking & { costSheetLines: CostSheetLine[] }) {
  return {
    id: booking.id,
    projectId: booking.projectId,
    unitId: booking.unitId,
    customerId: booking.customerId,
    bookingNumber: booking.bookingNumber,
    bookingDate: booking.bookingDate.toISOString(),
    status: booking.status,
    sellingAssociateId: booking.sellingAssociateId,
    priceListId: booking.priceListId,
    baseAmount: booking.baseAmount.toString(),
    plcAmount: booking.plcAmount.toString(),
    otherChargesAmount: booking.otherChargesAmount.toString(),
    discountAmount: booking.discountAmount.toString(),
    gstAmount: booking.gstAmount.toString(),
    stampDutyAmount: booking.stampDutyAmount.toString(),
    registrationAmount: booking.registrationAmount.toString(),
    agreementValue: booking.agreementValue.toString(),
    commissionableValue: booking.commissionableValue.toString(),
    confirmedAt: booking.confirmedAt?.toISOString() ?? null,
    costSheetLines: booking.costSheetLines.map((line: CostSheetLine) => ({
      chargeHeadCode: line.chargeHeadCode,
      description: line.description,
      amount: line.amount.toString(),
      gstAmount: line.gstAmount.toString(),
      countsTowardCommission: line.countsTowardCommission,
      displayOrder: line.displayOrder,
    })),
  };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ bookingId: string }> },
) {
  const { bookingId } = await params;
  const url = new URL(request.url);

  const token = readSessionToken(request);
  if (token === null) {
    return problemResponse({
      status: 401,
      type: "unauthenticated",
      title: "Unauthenticated",
      detail: "A session cookie or bearer token is required.",
      instance: url.pathname,
    });
  }

  const db = getPrismaClient();

  let session;
  try {
    session = await validateSession(db, token);
    await assertPermission(db, session.userId, "booking.read");
  } catch (error) {
    if (error instanceof SessionInvalidError) {
      return problemResponse({
        status: 401,
        type: "session-invalid",
        title: "Unauthenticated",
        detail: "The session is unknown, revoked or expired.",
        instance: url.pathname,
      });
    }
    if (error instanceof ForbiddenError) {
      return problemResponse({
        status: 403,
        type: "forbidden",
        title: "Forbidden",
        detail: 'This session lacks the "booking.read" permission.',
        instance: url.pathname,
      });
    }
    throw error;
  }

  const booking = await getBooking(db, { orgId: session.user.orgId, bookingId });
  if (booking === null) {
    return problemResponse({
      status: 404,
      type: "booking-not-found",
      title: "Not Found",
      detail: "No such booking.",
      instance: url.pathname,
    });
  }

  // Scope: ASSOCIATE/TEAM_LEAD only see their own or their downline's
  // bookings. Roles outside this set (SUPER_ADMIN, SALES_HEAD, SALES_ADMIN,
  // AUDITOR) already passed assertPermission above and see everything --
  // matching lead.read's exact O/T/unrestricted split.
  const roles = await db.userRole.findMany({
    where: { userId: session.userId },
    select: { role: { select: { code: true } } },
  });
  const roleCodes = roles.map((r) => r.role.code);
  const isScoped = roleCodes.every((code) => SCOPED_ROLE_CODES.has(code)) && roleCodes.length > 0;

  if (isScoped) {
    const caller = await db.associate.findUnique({ where: { userId: session.userId }, select: { id: true } });
    if (!caller) {
      return problemResponse({
        status: 403,
        type: "no-associate-profile",
        title: "Forbidden",
        detail: "This account has no associate profile.",
        instance: url.pathname,
      });
    }
    const mode = roleCodes.includes("TEAM_LEAD") ? "OWN_AND_DOWNLINE" : "OWN";
    const accessible = await getAccessibleAssociateIds(db, caller.id, mode);
    if (!accessible.includes(booking.sellingAssociateId)) {
      // 404, not 403: a scoped reader should not learn that a booking id
      // outside their scope exists at all, same reasoning the deltas route
      // and this slice's other routes use for cross-tenant lookups.
      return problemResponse({
        status: 404,
        type: "booking-not-found",
        title: "Not Found",
        detail: "No such booking.",
        instance: url.pathname,
      });
    }
  }

  return Response.json(serializeBooking(booking), { status: 200 });
}
