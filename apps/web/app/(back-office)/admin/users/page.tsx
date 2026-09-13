import type { Metadata } from "next";
import Link from "next/link";
import { getPrismaClient, ROLE_CODES, ROLE_NAMES } from "@desire/db";
import { listUsers } from "@desire/services/admin";
import { requireSession } from "@/lib/session";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { createUserAction, updateUserRolesAction } from "../actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Users — Desire",
};

const FIELD_CLASS =
  "h-9 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** Phase 3.5 Slice 15 -- confirmed gap, User/Role/RolePermission tables
 *  were seeded and read since Phase 0 but nothing ever exposed managing
 *  them. `createUser` assigns one existing role (not a new one) and
 *  returns a one-time temporary password -- this codebase has no invite-
 *  email flow, so it is shown once, right here, via a query param never
 *  logged or persisted anywhere except as the row's own hash. */
export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; created?: string; tempPassword?: string }>;
}) {
  const { error, created, tempPassword } = await searchParams;
  const session = await requireSession();
  const db = getPrismaClient();

  const users = await listUsers(db, { orgId: session.user.orgId, actorId: session.user.id });

  return (
    <main className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Users &amp; Roles</h1>
        <Link href="/admin" className="text-sm text-primary hover:underline">
          Admin
        </Link>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      {created && tempPassword ? (
        <p role="status" className="text-sm text-success">
          User created. One-time temporary password: <span className="font-mono font-semibold">{tempPassword}</span> — copy it now, it will not be shown again.
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>New user</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={createUserAction} className="grid gap-2 sm:grid-cols-4">
            <Input name="email" type="email" placeholder="Email" required />
            <Input name="name" placeholder="Full name" required />
            <select name="roleCode" defaultValue="" required className={FIELD_CLASS}>
              <option value="" disabled>
                Choose a role
              </option>
              {ROLE_CODES.map((code) => (
                <option key={code} value={code}>
                  {ROLE_NAMES[code]}
                </option>
              ))}
            </select>
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
                <th className="py-1.5 pr-4">Email</th>
                <th className="py-1.5 pr-4">Name</th>
                <th className="py-1.5 pr-4">Status</th>
                <th className="py-1.5 pr-4">Last login</th>
                <th className="py-1.5 pr-4">Role</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {users.map((user) => (
                <tr key={user.id}>
                  <td className="py-1.5 pr-4">{user.email}</td>
                  <td className="py-1.5 pr-4">{user.name}</td>
                  <td className="py-1.5 pr-4">{user.status}</td>
                  <td className="py-1.5 pr-4 tabular-nums">{user.lastLoginAt ? formatDate(user.lastLoginAt) : "Never"}</td>
                  <td className="py-1.5 pr-4">
                    <form action={updateUserRolesAction} className="flex items-center gap-1.5">
                      <input type="hidden" name="userId" value={user.id} />
                      <select name="roleCode" defaultValue={user.roleCodes[0] ?? ""} className={`${FIELD_CLASS} w-auto`}>
                        {ROLE_CODES.map((code) => (
                          <option key={code} value={code}>
                            {ROLE_NAMES[code]}
                          </option>
                        ))}
                      </select>
                      <Button type="submit" size="xs">
                        Update
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
