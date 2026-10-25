import type { Metadata } from "next";
import Link from "next/link";
import { CircleAlert, MailCheck } from "lucide-react";
import { RESET_TOKEN_TTL_MINUTES } from "@desire/services/password-reset";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { requestResetAction } from "./actions";

export const metadata: Metadata = {
  title: "Reset your password — Desire",
};

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; error?: string }>;
}) {
  const { sent, error } = await searchParams;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-muted p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Reset your password</CardTitle>
          <CardDescription>Enter the email you sign in with and we will send you a link to choose a new password.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {sent ? (
            <p role="status" className="flex items-start gap-1.5 text-sm text-success">
              <MailCheck className="mt-0.5 size-4 shrink-0" />
              If that address has an account, a link is on its way. It works once and expires in {RESET_TOKEN_TTL_MINUTES}{" "}
              minutes.
            </p>
          ) : (
            <form action={requestResetAction} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="email">Email</Label>
                <Input id="email" name="email" type="email" autoComplete="username" required autoFocus />
              </div>
              {error === "missing" ? (
                <p role="alert" className="flex items-start gap-1.5 text-sm text-danger">
                  <CircleAlert className="mt-0.5 size-4 shrink-0" />
                  Enter your email address.
                </p>
              ) : null}
              <Button type="submit" className="w-full">
                Send reset link
              </Button>
            </form>
          )}
          <Link href="/login" className="text-center text-sm text-primary hover:underline">
            Back to sign in
          </Link>
        </CardContent>
      </Card>
    </main>
  );
}
