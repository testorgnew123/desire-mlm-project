import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getPrismaClient, ROLE_CODES, ROLE_NAMES } from "@desire/db";
import type { RoleCode } from "@desire/db";
import { listUsers } from "@desire/services/admin";
import { getCachedSessionPermissions, requireSession } from "@/lib/session";
import { formatDate } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ConfirmSubmitButton } from "@/components/confirm-submit-button";
import { createUserAction, resetUserPasswordAction, updateUserRolesAction } from "../actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Users — Desire",
};

const FIELD_CLASS =
  "h-9 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** Users per page. The screen draws two forms for every row, so an unbounded list
 *  grew by several kilobytes a user (measured: 54 users, nearly half a megabyte). */
const PAGE_SIZE = 50;

interface UsersSearchParams {
  page?: string;
  error?: string;
  issued?: "created" | "reset";
  to?: string;
  emailed?: string;
  tempPassword?: string;
  note?: string;
}

/** Who may do what here is decided by the service (admin.ts): a Super Admin
 *  manages everyone, an Admin only associates. This page just draws the options
 *  that will work -- an Admin sees no role choices at all, because the only role
 *  they can hand out is Associate.
 *
 *  New accounts and resets email the login ID and a temporary password to the
 *  person. The admin sees the password here only when that email did not go. */
export default async function AdminUsersPage({ searchParams }: { searchParams: Promise<UsersSearchParams> }) {
  const { page: rawPage, error, issued, to, emailed, tempPassword, note } = await searchParams;
  // Clamped so a hand-edited ?page= cannot ask the database for an offset it cannot hold.
  const page = Math.min(1000, Math.max(1, Math.floor(Number(rawPage)) || 1));
  const session = await requireSession();
  const db = getPrismaClient();

  const permissions = await getCachedSessionPermissions(db, session.user.id);
  const canManageRoles = permissions.has("rbac.manage");
  if (!canManageRoles && !permissions.has("user.manage")) notFound();

  // One row more than the page, to learn whether a next page exists without a count query.
  const fetched = await listUsers(db, {
    orgId: session.user.orgId,
    actorId: session.user.id,
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE + 1,
  });
  const users = fetched.slice(0, PAGE_SIZE);
  const hasNext = fetched.length > PAGE_SIZE;
  const what = issued === "reset" ? "Password reset" : "Account created";

  return (
    <div className="flex flex-col gap-4">
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

      {issued && to && emailed ? (
        <p role="status" className="text-sm text-success">
          {what} for {to}. Their login ID and a temporary password were emailed to them; they choose their own at first sign-in.
        </p>
      ) : null}

      {issued && to && tempPassword ? (
        <p role="status" className="text-sm text-success">
          {what} for {to}, but the email was not sent{note ? ` (${note})` : ""}. Give them this one-time temporary password:{" "}
          <span className="font-mono font-semibold">{tempPassword}</span> — copy it now, it will not be shown again.
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
            {canManageRoles ? (
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
            ) : (
              <>
                <input type="hidden" name="roleCode" value={"ASSOCIATE" satisfies RoleCode} />
                <p className="flex items-center text-sm text-muted-foreground">Role: {ROLE_NAMES.ASSOCIATE}</p>
              </>
            )}
            <Button type="submit" size="sm">
              Create
            </Button>
          </form>
          <p className="mt-2 text-xs text-muted-foreground">
            The login ID and a temporary password are emailed to them automatically.
          </p>
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
                <th className="py-1.5 pr-4">Password</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {users.map((user) => (
                <tr key={user.id}>
                  <td className="py-1.5 pr-4">{user.email}</td>
                  <td className="py-1.5 pr-4">{user.name}</td>
                  <td className="py-1.5 pr-4">
                    <Badge variant="secondary">{user.status.replaceAll("_", " ")}</Badge>
                  </td>
                  <td className="py-1.5 pr-4 tabular-nums">{user.lastLoginAt ? formatDate(user.lastLoginAt) : "Never"}</td>
                  <td className="py-1.5 pr-4">
                    {canManageRoles && user.id !== session.user.id ? (
                      <form action={updateUserRolesAction} className="flex items-center gap-1.5">
                        <input type="hidden" name="userId" value={user.id} />
                        <select
                          name="roleCode"
                          defaultValue={user.roleCodes[0] ?? ""}
                          className={`${FIELD_CLASS} w-auto min-w-[8.5rem]`}
                        >
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
                    ) : (
                      user.roleCodes.map((code) => ROLE_NAMES[code as RoleCode] ?? code).join(", ")
                    )}
                  </td>
                  <td className="py-1.5 pr-4">
                    <form action={resetUserPasswordAction}>
                      <input type="hidden" name="userId" value={user.id} />
                      <ConfirmSubmitButton
                        size="xs"
                        variant="outline"
                        message={`Reset the password for ${user.email}? They are signed out and emailed a new one.`}
                      >
                        Reset password
                      </ConfirmSubmitButton>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {page > 1 || hasNext ? (
            <div className="mt-3 flex items-center justify-between text-sm">
              {page > 1 ? (
                <Link href={`/admin/users?page=${page - 1}`} className="text-primary hover:underline">
                  Previous
                </Link>
              ) : (
                <span />
              )}
              <span className="text-muted-foreground">Page {page}</span>
              {hasNext ? (
                <Link href={`/admin/users?page=${page + 1}`} className="text-primary hover:underline">
                  Next
                </Link>
              ) : (
                <span />
              )}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
