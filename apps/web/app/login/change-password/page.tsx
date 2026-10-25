import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { CircleAlert } from "lucide-react";
import { MIN_PASSWORD_LENGTH } from "@desire/services/password-reset";
import { readPendingPasswordChangeUserId } from "../pending";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { changePasswordAction } from "./actions";

export const metadata: Metadata = {
  title: "Choose a password — Desire",
};

export default async function ChangePasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const userId = await readPendingPasswordChangeUserId();
  if (!userId) redirect("/login");

  const { error } = await searchParams;
  const message = error === "mismatch" ? "The two passwords do not match." : error;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-muted p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Choose your password</CardTitle>
          <CardDescription>
            You signed in with a temporary password. Choose your own to continue — at least {MIN_PASSWORD_LENGTH}{" "}
            characters, and not the temporary one.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={changePasswordAction} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password">New password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={MIN_PASSWORD_LENGTH}
                required
                autoFocus
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="confirm">Confirm new password</Label>
              <Input
                id="confirm"
                name="confirm"
                type="password"
                autoComplete="new-password"
                minLength={MIN_PASSWORD_LENGTH}
                required
              />
            </div>
            {message ? (
              <p role="alert" className="flex items-start gap-1.5 text-sm text-danger">
                <CircleAlert className="mt-0.5 size-4 shrink-0" />
                {message}
              </p>
            ) : null}
            <Button type="submit" className="w-full">
              Save and continue
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
