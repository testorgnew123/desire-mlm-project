import type { Metadata } from "next";
import Link from "next/link";
import { getPrismaClient } from "@desire/db";
import { listNotificationRules } from "@desire/services/notifications";
import { requireSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { createNotificationRuleAction, toggleNotificationRuleAction } from "../actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Notification rules — Desire",
};

/** Phase 3.5 Slice 15 -- createNotificationRule already existed (Phase 2,
 *  built as a service only with no route or screen). This adds exactly
 *  what the plan calls for: reading the config and enabling/disabling a
 *  rule, not a redesign of the rule shape (channels/audience/templateKey
 *  stay free-text here, matching how evaluateNotificationRules already
 *  treats them -- data, not a fixed enum-driven builder). */
export default async function NotificationRulesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const session = await requireSession();
  const db = getPrismaClient();

  const rules = await listNotificationRules(db, { orgId: session.user.orgId, actorId: session.user.id });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Notification rules</h1>
        <Link href="/admin" className="text-sm text-primary hover:underline">
          Admin
        </Link>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>New rule</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={createNotificationRuleAction} className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Input name="code" placeholder="Code (e.g. HOLD_EXPIRING)" required />
            <Input name="name" placeholder="Name" required />
            <Input name="channels" placeholder="Channels (e.g. IN_APP)" required />
            <Input name="audience" placeholder="Audience (e.g. ASSOCIATE)" required />
            <Input name="templateKey" placeholder="Template key" required />
            <Button type="submit" size="sm">
              Create
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="overflow-x-auto">
          {rules.length === 0 ? (
            <p className="text-sm text-muted-foreground">No notification rules.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-1.5 pr-4">Code</th>
                  <th className="py-1.5 pr-4">Name</th>
                  <th className="py-1.5 pr-4">Channels</th>
                  <th className="py-1.5 pr-4">Audience</th>
                  <th className="py-1.5 pr-4">Enabled</th>
                  <th className="py-1.5 pr-4" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rules.map((rule) => (
                  <tr key={rule.id}>
                    <td className="py-1.5 pr-4">{rule.code}</td>
                    <td className="py-1.5 pr-4">{rule.name}</td>
                    <td className="py-1.5 pr-4">{rule.channels.join(", ")}</td>
                    <td className="py-1.5 pr-4">{rule.audience.join(", ")}</td>
                    <td className="py-1.5 pr-4">{rule.enabled ? "Yes" : "No"}</td>
                    <td className="py-1.5 pr-4">
                      <form action={toggleNotificationRuleAction}>
                        <input type="hidden" name="ruleId" value={rule.id} />
                        <input type="hidden" name="enabled" value={rule.enabled ? "false" : "true"} />
                        <Button type="submit" size="xs" variant={rule.enabled ? "destructive" : "default"}>
                          {rule.enabled ? "Disable" : "Enable"}
                        </Button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
