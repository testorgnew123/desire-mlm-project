// CSV bulk import of units/plots.
//
// importUnits has existed, tested, since the inventory slice, and its own
// header says parsing "belongs to the route layer" -- that route was never
// built, which is why until now units could only come from the seed script.
// This is that route and nothing more: parse, hand rows to the service, return
// its report verbatim.
//
// CSV only, deliberately. packages/services/src/xlsx.ts wraps exceljs for
// WRITING; adding a reader is a separate decision and a spreadsheet exported
// as CSV covers the actual need.
import { getPrismaClient } from "@desire/db";
import { SessionInvalidError, validateSession } from "@desire/services/auth";
import { ForbiddenError } from "@desire/services/rbac";
import {
  UnitImportConflictError,
  UnitImportRejectedError,
  UnitImportTargetError,
  importUnits,
  type RawUnitRow,
} from "@desire/services/unit-import";
import { readSessionToken } from "@/lib/api-session";

export const dynamic = "force-dynamic";

const INSTANCE = "/api/v1/projects/{projectId}/units/import";

/** Same RFC 7807 shape every other route in this directory emits. There is no
 *  shared helper to import -- api-session.ts's header explains that
 *  retrofitting the existing 30+ routes is a separate cleanup -- so this
 *  matches the convention rather than inventing a third one. */
function problemResponse(status: number, type: string, title: string, detail: string): Response {
  return Response.json(
    {
      type: `https://docs.internal/errors/${type}`,
      title,
      status,
      detail,
      instance: INSTANCE,
    },
    { status, headers: { "content-type": "application/problem+json" } },
  );
}

/** Minimal RFC-4180-ish reader: quoted fields, embedded commas, doubled quotes
 *  and CRLF. Deliberately not a dependency -- the file is a handful of columns
 *  produced by Excel, and the service does every bit of real validation.
 *
 *  Two things beyond the format, both for the downloadable template:
 *  - a leading byte-order mark is dropped. Excel's "CSV UTF-8" adds one, and
 *    left in it glues itself to the first header and turns unitNumber into
 *    "\uFEFFunitNumber", failing every row;
 *  - a row whose FIRST cell starts with # is a note, not data, and is skipped.
 *    The template's explanations and examples use this. It is counted and
 *    reported back rather than dropped silently, because a real unit number
 *    that began with # would otherwise vanish without a trace. */
function parseCsv(input: string): { rows: string[][]; comments: number } {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Drop trailing blank lines, which every spreadsheet export produces and
  // which would otherwise each become an error row.
  const nonBlank = rows.filter((r) => r.some((cell) => cell.trim() !== ""));
  const data = nonBlank.filter((r) => !(r[0] ?? "").trim().startsWith("#"));
  return { rows: data, comments: nonBlank.length - data.length };
}

/** "CORNER|PARK_FACING" -> ["CORNER","PARK_FACING"]; empty -> []. Blank
 *  segments are dropped rather than passed on: the service rejects an empty
 *  tag, and a trailing pipe is a typo, not an intent. */
function splitTags(cell: string): string[] {
  return cell
    .split("|")
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "");
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  const token = readSessionToken(request);
  if (token === null) {
    return problemResponse(401, "unauthorized", "Unauthorized", "Sign in to import units.");
  }

  const db = getPrismaClient();
  let session;
  try {
    session = await validateSession(db, token);
  } catch (error) {
    if (error instanceof SessionInvalidError) {
      return problemResponse(401, "unauthorized", "Unauthorized", "Session is not valid.");
    }
    throw error;
  }

  const { projectId } = await params;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return problemResponse(400, "bad-request", "Bad Request", "Expected a multipart form upload.");
  }

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return problemResponse(400, "bad-request", "Bad Request", "Attach a CSV file.");
  }

  const { rows: table, comments: ignoredComments } = parseCsv(await file.text());
  if (table.length < 2) {
    return problemResponse(
      400,
      "bad-request",
      "Bad Request",
      "The file needs a header row and at least one data row." +
        (ignoredComments > 0
          ? ` ${ignoredComments} line(s) starting with # were ignored -- notes and examples are not imported.`
          : ""),
    );
  }

  // The header names the columns the service already knows (unitNumber,
  // unitTypeCode, floor, facing, plcTags, carpetAreaOverride,
  // saleableAreaOverride). Unknown columns pass through and are ignored by
  // validateUnitImportRows rather than failing the file.
  const header = table[0]!.map((h) => h.trim());
  const rows: RawUnitRow[] = table.slice(1).map((cells) => {
    const row: RawUnitRow = {};
    header.forEach((key, index) => {
      if (key === "") return;
      const cell = cells[index] ?? "";
      // plcTags is the one structured column. validateUnitImportRows expects
      // an array and says so in its own comment -- "the parser splits a
      // delimited cell; this layer never sees 'A|B'" -- so splitting it is
      // this route's job, not the service's. Pipe rather than comma, because
      // a comma inside an unquoted CSV cell is a column break.
      row[key] = key === "plcTags" ? splitTags(cell) : cell;
    });
    return row;
  });

  const towerId = form.get("towerId");

  try {
    const report = await importUnits(db, {
      orgId: session.user.orgId,
      projectId,
      towerId: typeof towerId === "string" && towerId !== "" ? towerId : undefined,
      rows,
      audit: {
        orgId: session.user.orgId,
        actorId: session.user.id,
        actorLabel: session.user.name,
      },
    });
    return Response.json({ ...report, ignoredComments });
  } catch (error) {
    // ALL_OR_NOTHING (the default) THROWS with the whole report attached
    // rather than returning it, specifically so the route can render every
    // problem at once -- an importer that surfaces one error per upload makes
    // a 400-row file take 400 uploads. Nothing was written.
    if (error instanceof UnitImportRejectedError) {
      return Response.json(
        {
          type: "https://docs.internal/errors/unit-import-rejected",
          title: "Import rejected",
          status: 422,
          detail: error.message,
          instance: INSTANCE,
          report: error.report,
          ignoredComments,
        },
        { status: 422, headers: { "content-type": "application/problem+json" } },
      );
    }
    if (error instanceof UnitImportConflictError) {
      return problemResponse(409, "conflict", "Conflict", error.message);
    }
    if (error instanceof ForbiddenError) {
      return problemResponse(403, "forbidden", "Forbidden", error.message);
    }
    if (error instanceof UnitImportTargetError) {
      return problemResponse(422, "unprocessable-entity", "Unprocessable Entity", error.message);
    }
    throw error;
  }
}
