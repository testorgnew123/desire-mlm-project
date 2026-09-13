import type { Metadata } from "next";
import Link from "next/link";
import { getPrismaClient } from "@desire/db";
import { getAssociateTree } from "@desire/services/associates";
import { getEarnings } from "@desire/services/commission";
import { requireSession } from "@/lib/session";
import { formatMoney } from "@/lib/money";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { moveAssociateAction, assignGradeAction } from "../../actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Associate — Desire",
};

const FIELD_CLASS =
  "h-9 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** Detail + downline + earnings + the two mutations 08-SCREENS.md names for
 *  this screen (move, grade change) -- same "detail page folds its own
 *  actions" pattern as CRM's lead detail (Slice 9) and the Booking detail
 *  page (Slice 10). Candidate parents/grades are listed org-wide rather
 *  than pre-filtered client-side; moveAssociate's own cycle detection and
 *  PayoutPeriodOpenError are the real guards, same as every other maker-
 *  checker screen in this phase trusting the service layer's own checks. */
export default async function AssociateDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ associateId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { associateId } = await params;
  const { error } = await searchParams;
  const session = await requireSession();
  const db = getPrismaClient();

  const tree = await getAssociateTree(db, { associateId, orgId: session.user.orgId, actorId: session.user.id });

  const [earnings, candidateParents, grades] = await Promise.all([
    getEarnings(db, {
      associateId,
      audit: { orgId: session.user.orgId, actorId: session.user.id, actorLabel: session.user.name },
    }),
    db.associate.findMany({
      where: { orgId: session.user.orgId, id: { not: associateId } },
      select: { id: true, code: true, user: { select: { name: true } } },
      orderBy: { code: "asc" },
    }),
    db.grade.findMany({ where: { orgId: session.user.orgId, isActive: true }, orderBy: { rank: "asc" } }),
  ]);

  return (
    <main className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold">{tree.associate.name}</h1>
        <p className="text-sm text-muted-foreground">
          {tree.associate.code} · {tree.associate.gradeCode ?? "No grade"} · {tree.associate.status}
        </p>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Earnings</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <p className="text-xs text-muted-foreground">Accrued</p>
            <p className="font-medium">{formatMoney(earnings.accrued)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Payable</p>
            <p className="font-medium">{formatMoney(earnings.payable)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Paid</p>
            <p className="font-medium">{formatMoney(earnings.paid)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Blocked (pending collections)</p>
            <p className="font-medium">{formatMoney(earnings.blocked)}</p>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Move in hierarchy</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={moveAssociateAction} className="flex flex-col gap-2">
              <input type="hidden" name="associateId" value={associateId} />
              <select name="newParentId" defaultValue="" className={FIELD_CLASS}>
                <option value="">— Top of tree (no parent) —</option>
                {candidateParents.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.user.name} ({candidate.code})
                  </option>
                ))}
              </select>
              <Input name="reason" placeholder="Reason (required)" required />
              <Button type="submit" size="sm" className="self-start">
                Move
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Assign grade</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={assignGradeAction} className="flex flex-col gap-2">
              <input type="hidden" name="associateId" value={associateId} />
              <select name="gradeId" defaultValue="" required className={FIELD_CLASS}>
                <option value="" disabled>
                  Choose a grade
                </option>
                {grades.map((grade) => (
                  <option key={grade.id} value={grade.id}>
                    {grade.name} ({grade.code})
                  </option>
                ))}
              </select>
              <Input name="reason" placeholder="Reason (optional)" />
              <Button type="submit" size="sm" className="self-start">
                Assign
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Downline ({tree.downline.length})</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {tree.downline.length === 0 ? (
            <p className="text-sm text-muted-foreground">No downline.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-1.5 pr-4">Code</th>
                  <th className="py-1.5 pr-4">Name</th>
                  <th className="py-1.5 pr-4">Grade</th>
                  <th className="py-1.5 pr-4 text-right">Depth</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {tree.downline.map((member) => (
                  <tr key={member.associateId}>
                    <td className="py-1.5 pr-4">{member.code}</td>
                    <td className="py-1.5 pr-4">
                      <Link href={`/network/associates/${member.associateId}`} className="hover:underline">
                        {member.name}
                      </Link>
                    </td>
                    <td className="py-1.5 pr-4">{member.gradeCode ?? "—"}</td>
                    <td className="py-1.5 pr-4 text-right tabular-nums">{member.depth}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
