import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getPrismaClient, ROLE_NAMES } from "@desire/db";
import type { RoleCode } from "@desire/db";
import { getUser } from "@desire/services/admin";
import { getCachedSessionPermissions, requireSession } from "@/lib/session";
import { formatDateTime } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { deleteUserAction, resetUserPasswordAction, setUserDisabledAction, updateUserAction } from "../../actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "User — Desire",
};

/** One account: change its name and email, send it a new password, switch it off or
 *  on, or delete it. Who may do what is decided by the service (admin.ts), the same
 *  ceiling as the list: an Admin reaches associates only (anything else is a 404 here),
 *  a Super Admin everyone. This page draws the options that can work. */
export default async function AdminUserPage({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;
  const session = await requireSession();
  const db = getPrismaClient();

  const permissions = await getCachedSessionPermissions(db, session.user.id);
  if (!permissions.has("rbac.manage") && !permissions.has("user.manage")) notFound();

  const user = await getUser(db, { orgId: session.user.orgId, actorId: session.user.id, userId });
  if (!user) notFound();

  const isSelf = user.id === session.user.id;
  const switchedOff = user.status === "DISABLED" || user.status === "SUSPENDED";
  const roles = user.roleCodes.map((code) => ROLE_NAMES[code as RoleCode] ?? code).join(", ");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">{user.name}</h1>
        <Link href="/admin/users" className="text-sm text-primary hover:underline">
          Users &amp; Roles
        </Link>
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <span>{user.email}</span>
          <span className="text-muted-foreground">{roles}</span>
          <Badge variant={switchedOff ? "danger" : "secondary"}>{user.status.replaceAll("_", " ")}</Badge>
          <span className="text-muted-foreground">
            Last sign-in: {user.lastLoginAt ? formatDateTime(user.lastLoginAt) : "never"}
          </span>
          {user.associateCode ? <span className="text-muted-foreground">Associate code {user.associateCode}</span> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
          <CardDescription>The email is the login ID.</CardDescription>
        </CardHeader>
        <CardContent>
          <ActionForm id="edit-user" action={updateUserAction} resetOnSuccess={false} className="flex flex-col gap-3">
            <input type="hidden" name="userId" value={user.id} />
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs font-medium">
                Full name
                <Input name="name" defaultValue={user.name} required />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium">
                Email
                <Input name="email" type="email" defaultValue={user.email} required />
              </label>
            </div>
            <SubmitButton size="sm" className="self-start" pendingLabel="Saving…">
              Save
            </SubmitButton>
          </ActionForm>
          <p className="mt-2 text-xs text-muted-foreground">
            A new email becomes the login ID. Nothing is sent to it: use Reset password below to email the login to the new
            address. An Admin or Associate email must be on a company domain.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Password</CardTitle>
          <CardDescription>Emails a new temporary password, and signs them out everywhere.</CardDescription>
        </CardHeader>
        <CardContent>
          <ActionForm id="reset-password" action={resetUserPasswordAction} resetOnSuccess={false} className="flex flex-col gap-2">
            <input type="hidden" name="userId" value={user.id} />
            <SubmitButton
              size="sm"
              variant="outline"
              className="self-start"
              pendingLabel="Resetting…"
              confirm={`Reset the password for ${user.email}? They are signed out and emailed a new one.`}
            >
              Reset password
            </SubmitButton>
          </ActionForm>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Access</CardTitle>
          <CardDescription>
            {switchedOff
              ? "This account is disabled and cannot sign in. Its holds, bookings and history are kept."
              : "A disabled account cannot sign in and is signed out everywhere. Its holds, bookings and history are kept, and it can be enabled again."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isSelf ? (
            <p className="text-sm text-muted-foreground">You cannot disable your own account.</p>
          ) : (
            <ActionForm id="access" action={setUserDisabledAction} resetOnSuccess={false} className="flex flex-col gap-2">
              <input type="hidden" name="userId" value={user.id} />
              <input type="hidden" name="disabled" value={switchedOff ? "false" : "true"} />
              <SubmitButton
                size="sm"
                variant={switchedOff ? "default" : "outline"}
                className="self-start"
                pendingLabel={switchedOff ? "Enabling…" : "Disabling…"}
                confirm={
                  switchedOff ? undefined : `Disable ${user.email}? They are signed out and cannot sign in until you enable the account.`
                }
              >
                {switchedOff ? "Enable account" : "Disable account"}
              </SubmitButton>
            </ActionForm>
          )}
        </CardContent>
      </Card>

      {user.lastLoginAt === null && !isSelf ? (
        <Card>
          <CardHeader>
            <CardTitle>Delete</CardTitle>
            <CardDescription>
              Removes an account that never signed in, such as one made with a wrong address. If it has holds, bookings or other
              activity it cannot be deleted: disable it instead.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ActionForm id="delete-user" action={deleteUserAction} resetOnSuccess={false} className="flex flex-col gap-2">
              <input type="hidden" name="userId" value={user.id} />
              <SubmitButton
                size="sm"
                variant="destructive"
                className="self-start"
                pendingLabel="Deleting…"
                confirm={`Delete ${user.email}? This cannot be undone.`}
              >
                Delete account
              </SubmitButton>
            </ActionForm>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
