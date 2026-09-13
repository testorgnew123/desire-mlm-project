import type { Metadata } from "next";
import Link from "next/link";
import { getPrismaClient } from "@desire/db";
import { requireSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { createGradeAction, toggleGradeActiveAction } from "../actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Grades — Desire",
};

/** Phase 3.5 Slice 12 -- confirmed gap, createGrade/updateGrade had zero
 *  routes and zero screen. Grade thresholds are PLACEHOLDER per grades.ts's
 *  own header comment (BLOCKED#4/#8), so this screen edits the mechanism
 *  (code/name/rank/active) real callers need today; the threshold fields
 *  are visible read-only rather than a full edit form for numbers nobody
 *  has confirmed yet. */
export default async function GradesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const session = await requireSession();
  const db = getPrismaClient();

  const grades = await db.grade.findMany({ where: { orgId: session.user.orgId }, orderBy: { rank: "asc" } });

  return (
    <main className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Grades</h1>
        <Link href="/network" className="text-sm text-primary hover:underline">
          Org tree
        </Link>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>New grade</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={createGradeAction} className="grid gap-2 sm:grid-cols-4">
            <Input name="code" placeholder="Code (e.g. G6)" required />
            <Input name="name" placeholder="Name" required />
            <Input name="rank" type="number" placeholder="Rank" required />
            <Button type="submit" size="sm">
              Create
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-1.5 pr-4">Rank</th>
                <th className="py-1.5 pr-4">Code</th>
                <th className="py-1.5 pr-4">Name</th>
                <th className="py-1.5 pr-4 text-right">Hold quota</th>
                <th className="py-1.5 pr-4">Active</th>
                <th className="py-1.5 pr-4" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {grades.map((grade) => (
                <tr key={grade.id}>
                  <td className="py-1.5 pr-4 tabular-nums">{grade.rank}</td>
                  <td className="py-1.5 pr-4">{grade.code}</td>
                  <td className="py-1.5 pr-4">{grade.name}</td>
                  <td className="py-1.5 pr-4 text-right tabular-nums">{grade.holdQuota}</td>
                  <td className="py-1.5 pr-4">{grade.isActive ? "Yes" : "No"}</td>
                  <td className="py-1.5 pr-4">
                    <form action={toggleGradeActiveAction}>
                      <input type="hidden" name="gradeId" value={grade.id} />
                      <input type="hidden" name="isActive" value={grade.isActive ? "false" : "true"} />
                      <Button type="submit" size="xs" variant={grade.isActive ? "destructive" : "default"}>
                        {grade.isActive ? "Deactivate" : "Activate"}
                      </Button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </main>
  );
}
