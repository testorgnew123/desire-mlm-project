// Draft a booking from a held unit -- POST /bookings in docs/07-API.md
// ("Creates DRAFT from a held unit"). Thin by design: resolve the actor,
// scope the target unit, call createDraftBooking, shape the response. Every
// real guard -- the row lock, the hold-ownership check, the cost-sheet
// preview -- lives in packages/services/src/bookings.ts.
import { getPrismaClient } from "@desire/db";
// Narrow subpath imports, not the "@desire/services" barrel: the barrel pulls
// auth.ts -> @node-rs/argon2, a native .node addon webpack cannot parse, and
// that fails `next build` outright.
import { SessionInvalidError, validateSession } from "@desire/services/auth";
import { ForbiddenError } from "@desire/services/rbac";
import {
  HeldByAnotherAssociateError,
  InvalidPriceListError,
  UnitNotHeldError,
  createDraftBooking,
  type Booking,
} from "@desire/services/bookings";

export const dynamic = "force-dynamic";

const SESSION_COOKIE_NAME = "desire_session";

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

/** Money as strings, never floats (docs/07-API.md). Dates as ISO 8601. */
function serializeBooking(booking: Booking) {
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
    saleableAreaAtBooking: booking.saleableAreaAtBooking.toString(),
    carpetAreaAtBooking: booking.carpetAreaAtBooking.toString(),
    createdAt: booking.createdAt.toISOString(),
  };
}

interface CreateBookingBody {
  unitId?: unknown;
  priceListId?: unknown;
  customerId?: unknown;
  sellingAssociateId?: unknown;
  paymentPlanId?: unknown;
  bookingDate?: unknown;
}

export async function POST(request: Request) {
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
    throw error;
  }

  let body: CreateBookingBody;
  try {
    body = (await request.json()) as CreateBookingBody;
  } catch {
    return problemResponse({
      status: 400,
      type: "invalid-body",
      title: "Invalid request body",
      detail: "Request body must be valid JSON.",
      instance: url.pathname,
    });
  }
  if (typeof body.unitId !== "string" || typeof body.priceListId !== "string" || typeof body.customerId !== "string") {
    return problemResponse({
      status: 400,
      type: "invalid-body",
      title: "Invalid request body",
      detail: "unitId, priceListId and customerId are required strings.",
      instance: url.pathname,
    });
  }

  try {
    const booking = await createDraftBooking(db, {
      unitId: body.unitId,
      priceListId: body.priceListId,
      customerId: body.customerId,
      sellingAssociateId: typeof body.sellingAssociateId === "string" ? body.sellingAssociateId : undefined,
      paymentPlanId: typeof body.paymentPlanId === "string" ? body.paymentPlanId : undefined,
      bookingDate: typeof body.bookingDate === "string" ? new Date(body.bookingDate) : undefined,
      audit: { orgId: session.user.orgId, actorId: session.userId, actorLabel: session.user.name },
    });

    const auditId = await db.auditLog
      .findFirst({
        where: { entity: "Booking", entityId: booking.id, action: "CREATE" },
        select: { id: true },
        orderBy: { createdAt: "desc" },
      })
      .then((row) => row?.id ?? null);

    return Response.json({ ...serializeBooking(booking), auditId }, { status: 201 });
  } catch (error) {
    if (error instanceof ForbiddenError) {
      // Unlike the holds route (one 403 cause -> a fixed generic string),
      // bookings.ts throws ForbiddenError for several distinct, already-safe
      // reasons -- missing permission, no Associate profile, naming an
      // associate outside your scope, cross-org access. Each message is
      // specific to the caller's OWN request and identity, so it is shown
      // verbatim rather than flattened to one generic string.
      return problemResponse({
        status: 403,
        type: "forbidden",
        title: "Forbidden",
        detail: error.message,
        instance: url.pathname,
      });
    }
    if (error instanceof UnitNotHeldError || error instanceof HeldByAnotherAssociateError) {
      return problemResponse({
        status: 409,
        type: "unit-not-available-for-booking",
        title: "Unit not available",
        detail: error.message,
        instance: url.pathname,
      });
    }
    if (error instanceof InvalidPriceListError) {
      return problemResponse({
        status: 422,
        type: "invalid-price-list",
        title: "Price list not usable",
        detail: error.message,
        instance: url.pathname,
      });
    }
    throw error;
  }
}
