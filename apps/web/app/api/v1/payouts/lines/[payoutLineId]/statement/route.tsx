// Commission statement PDF -- GET /payout-lines/:id/statement
// (docs/07-API.md, documented but never built). Closes the Phase 4
// checklist item "Commission statement PDF matching the ledger exactly" --
// explicitly deferred in Phase 3.5 Slice 14 pending a PDF-library decision,
// made now. Thin handler; the real derivation data comes straight from
// packages/services/src/payouts.ts's getPayoutLineStatement, the same
// CommissionEntry.snapshot data Slice 5's "Explain this number" screen
// already renders -- this is that same data, laid out as a document
// instead of a page.
import { renderToBuffer, Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";
import { getPrismaClient } from "@desire/db";
import { SessionInvalidError, validateSession } from "@desire/services/auth";
import { ForbiddenError } from "@desire/services/rbac";
import { PayoutLineNotFoundError, getPayoutLineStatement, type PayoutLineStatement } from "@desire/services/payouts";
import { readSessionToken } from "@/lib/api-session";

export const dynamic = "force-dynamic";

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

const styles = StyleSheet.create({
  page: { padding: 32, fontSize: 10, fontFamily: "Helvetica" },
  title: { fontSize: 16, marginBottom: 4 },
  subtitle: { fontSize: 10, color: "#64748b", marginBottom: 16 },
  sectionTitle: { fontSize: 12, marginTop: 16, marginBottom: 6, fontFamily: "Helvetica-Bold" },
  row: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#e2e8f0", paddingVertical: 4 },
  headerRow: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#0f172a", paddingBottom: 4, fontFamily: "Helvetica-Bold" },
  colWide: { flex: 2 },
  col: { flex: 1, textAlign: "right" },
  totalsRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 3 },
});

function formatMoney(value: string): string {
  return `Rs. ${Number(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function StatementDocument({ statement }: { statement: PayoutLineStatement }) {
  const { line, batch, associate, entries } = statement;
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <Text style={styles.title}>Commission Statement</Text>
        <Text style={styles.subtitle}>
          {associate.name} · Batch {batch.batchNumber} · {new Date(batch.periodStart).toLocaleDateString("en-IN")} -{" "}
          {new Date(batch.periodEnd).toLocaleDateString("en-IN")}
        </Text>

        <Text style={styles.sectionTitle}>Commission entries</Text>
        <View style={styles.headerRow}>
          <Text style={styles.colWide}>Role</Text>
          <Text style={styles.col}>Level</Text>
          <Text style={styles.col}>Amount</Text>
        </View>
        {entries.map(({ entry }) => (
          <View style={styles.row} key={entry.id}>
            <Text style={styles.colWide}>{entry.role}</Text>
            <Text style={styles.col}>{entry.level}</Text>
            <Text style={styles.col}>{formatMoney(entry.grossAmount.toString())}</Text>
          </View>
        ))}

        <Text style={styles.sectionTitle}>Totals</Text>
        <View style={styles.totalsRow}>
          <Text>Gross</Text>
          <Text>{formatMoney(line.grossAmount.toString())}</Text>
        </View>
        <View style={styles.totalsRow}>
          <Text>TDS ({line.tdsSection}, {line.tdsRatePct.toString()}%)</Text>
          <Text>-{formatMoney(line.tdsAmount.toString())}</Text>
        </View>
        {line.gstAmount.toString() !== "0" ? (
          <View style={styles.totalsRow}>
            <Text>GST ({line.gstRatePct?.toString()}%)</Text>
            <Text>+{formatMoney(line.gstAmount.toString())}</Text>
          </View>
        ) : null}
        {line.recoveryAdjustment.toString() !== "0" ? (
          <View style={styles.totalsRow}>
            <Text>Recovery adjustment</Text>
            <Text>-{formatMoney(line.recoveryAdjustment.toString())}</Text>
          </View>
        ) : null}
        <View style={[styles.totalsRow, { borderTopWidth: 1, borderTopColor: "#0f172a", paddingTop: 4, marginTop: 4 }]}>
          <Text style={{ fontFamily: "Helvetica-Bold" }}>Net payable</Text>
          <Text style={{ fontFamily: "Helvetica-Bold" }}>{formatMoney(line.netPayable.toString())}</Text>
        </View>
      </Page>
    </Document>
  );
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ payoutLineId: string }> },
) {
  const { payoutLineId } = await params;
  const url = new URL(request.url);

  const token = readSessionToken(request);
  if (token === null) {
    return problemResponse({
      status: 401, type: "unauthenticated", title: "Unauthenticated",
      detail: "A session cookie or bearer token is required.", instance: url.pathname,
    });
  }

  const db = getPrismaClient();

  let session;
  try {
    session = await validateSession(db, token);
  } catch (error) {
    if (error instanceof SessionInvalidError) {
      return problemResponse({
        status: 401, type: "session-invalid", title: "Unauthenticated",
        detail: "The session is unknown, revoked or expired.", instance: url.pathname,
      });
    }
    throw error;
  }

  let statement;
  try {
    statement = await getPayoutLineStatement(db, { orgId: session.user.orgId, actorId: session.userId, payoutLineId });
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return problemResponse({
        status: 403, type: "forbidden", title: "Forbidden", detail: error.message, instance: url.pathname,
      });
    }
    if (error instanceof PayoutLineNotFoundError) {
      return problemResponse({
        status: 404, type: "payout-line-not-found", title: "Not Found", detail: error.message, instance: url.pathname,
      });
    }
    throw error;
  }

  const pdfBuffer = await renderToBuffer(<StatementDocument statement={statement} />);

  return new Response(new Uint8Array(pdfBuffer), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="statement-${statement.batch.batchNumber}-${statement.associate.code}.pdf"`,
    },
  });
}
