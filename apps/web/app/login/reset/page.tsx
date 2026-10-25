import type { Metadata } from "next";
import Link from "next/link";
import { CircleAlert } from "lucide-react";
import { getPrismaClient } from "@desire/db";
import { MIN_PASSWORD_LENGTH, isResetTokenUsable } from "@desire/services/password-reset";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { resetPasswordAction } from "./actions";

export const metadata: Metadata = {
  title: "Choose a new password — Desire",
  // The link carries the secret in its query string; never hand it to another
  // site as a Referer.
  referrer: "no-referrer",
};

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  const { token, error } = await searchParams;
  const usable = token ? await isResetTokenUsable(getPrismaClient(), token) : false;

  if (!token || !usable) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-muted p-4">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>This link has expired</CardTitle>
            <CardDescription>
              A reset link works once and only for a short time. Ask for a new one and use the latest email.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <Button nativeButton={false} render={<Link href="/login/forgot" />}>
              Send a new link
            </Button>
            <Link href="/login" className="text-center text-sm text-primary hover:underline">
              Back to sign in
            </Link>
          </CardContent>
        </Card>
      </main>
    );
  }

  const message = error === "mismatch" ? "The two passwords do not match." : error;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-muted p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Choose a new password</CardTitle>
          <CardDescription>At least {MIN_PASSWORD_LENGTH} characters. You will be signed out everywhere else.</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={resetPasswordAction} className="flex flex-col gap-4">
            <input type="hidden" name="token" value={token} />
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
              Save new password
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
