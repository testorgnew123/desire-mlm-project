import type { Metadata } from "next";
import Link from "next/link";
import { getPrismaClient } from "@desire/db";
import { listAssociates } from "@desire/services/associates";
import { requireSession } from "@/lib/session";
import { Card, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Network — Desire",
};

/** Org tree: listAssociates already carries depth + parentId, so the tree
 *  is this same read rendered depth-first (parent immediately followed by
 *  its descendants) with indentation, rather than a second aggregation --
 *  the flat table view of the identical data is /network/associates. */
export default async function NetworkPage() {
  const session = await requireSession();
  const db = getPrismaClient();

  const associates = await listAssociates(db, { orgId: session.user.orgId, actorId: session.user.id });

  const byParent = new Map<string | null, typeof associates>();
  for (const associate of associates) {
    const key = associate.parentId;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(associate);
  }

  const ordered: typeof associates = [];
  function walk(parentId: string | null) {
    for (const associate of byParent.get(parentId) ?? []) {
      ordered.push(associate);
      walk(associate.associateId);
    }
  }
  walk(null);
  // Any associate whose parent isn't in this scoped set (e.g. a TEAM_LEAD's
  // own upline, outside their downline scope) still needs to render --
  // appended at the end rather than silently dropped.
  const seen = new Set(ordered.map((a) => a.associateId));
  for (const associate of associates) {
    if (!seen.has(associate.associateId)) ordered.push(associate);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Network — Org tree</h1>
        <div className="flex gap-3 text-sm">
          <Link href="/network/associates" className="text-primary hover:underline">
            Associates list
          </Link>
          <Link href="/network/grades" className="text-primary hover:underline">
            Grades
          </Link>
          <Link href="/network/promotions" className="text-primary hover:underline">
            Promotions
          </Link>
        </div>
      </div>

      <Card>
        <CardContent>
          {ordered.length === 0 ? (
            <p className="text-sm text-muted-foreground">No associates.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {ordered.map((associate) => (
                <li key={associate.associateId} style={{ paddingLeft: `${associate.depth * 1.25}rem` }}>
                  <Link href={`/network/associates/${associate.associateId}`} className="hover:underline">
                    {associate.name}
                  </Link>{" "}
                  <span className="text-xs text-muted-foreground">
                    ({associate.code} · {associate.gradeCode ?? "—"} · {associate.status})
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
