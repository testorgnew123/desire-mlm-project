import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CircleAlert, CircleCheck } from "lucide-react";
import { mailSettingsStatus } from "@desire/services/email";
import { getCachedSessionPermissions, requireSession } from "@/lib/session";
import { getPrismaClient } from "@desire/db";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { sendTestEmailAction } from "./actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Email — Desire",
};

/** Proves email works on this server: which settings are present (never their
 *  values) and a button that sends one real message and says exactly why it did
 *  not go. Everything that mails people (new accounts, password resets, booking
 *  confirmations) uses these same settings. */
export default async function AdminMailPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; error?: string }>;
}) {
  const { sent, error } = await searchParams;
  const session = await requireSession();
  const permissions = await getCachedSessionPermissions(getPrismaClient(), session.user.id);
  if (!permissions.has("user.manage")) notFound();

  const settings = mailSettingsStatus();
  const missing = settings.filter((setting) => setting.required && !setting.set);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold">Email</h1>
        <p className="text-sm text-muted-foreground">
          New-user logins, password resets and booking emails are all sent with these settings.
        </p>
      </div>

      {sent ? (
        <p role="status" className="flex items-start gap-1.5 text-sm text-success">
          <CircleCheck className="mt-0.5 size-4 shrink-0" />
          Sent. Check that inbox, and its spam folder, to be sure it arrived.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="flex items-start gap-1.5 text-sm text-danger">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          {error}
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Settings</CardTitle>
          <CardDescription>
            Set on the server (Netlify &gt; Environment variables). Values are never shown here.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <ul className="flex flex-col divide-y divide-border text-sm">
            {settings.map((setting) => (
              <li key={setting.name} className="flex items-center justify-between gap-3 py-1.5">
                <span>
                  <code className="font-mono text-xs">{setting.name}</code>
                  <span className="block text-xs text-muted-foreground">{setting.note}</span>
                </span>
                <Badge variant={setting.set ? "success" : setting.required ? "danger" : "secondary"} className="font-normal">
                  {setting.set ? "set" : setting.required ? "missing" : "not set (optional)"}
                </Badge>
              </li>
            ))}
          </ul>
          {missing.length > 0 ? (
            <p className="text-xs text-danger">
              Email will not work until {missing.map((setting) => setting.name).join(", ")} {missing.length === 1 ? "is" : "are"} set.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Send a test email</CardTitle>
          <CardDescription>Sends one real message to the address you give.</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={sendTestEmailAction} className="flex flex-wrap items-end gap-2">
            <label className="flex min-w-64 flex-1 flex-col gap-1 text-xs font-medium">
              Send to
              <Input name="to" type="email" required autoComplete="off" placeholder="you@example.com" />
            </label>
            <Button type="submit" size="sm">
              Send test email
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
