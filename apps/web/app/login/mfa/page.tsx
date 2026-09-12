import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { readPendingMfaUserId } from "../pending";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { verifyMfaAction } from "./actions";

export const metadata: Metadata = {
  title: "Verify your identity — Desire",
};

export default async function MfaChallengePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const userId = await readPendingMfaUserId();
  if (!userId) redirect("/login");

  const { error } = await searchParams;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-muted p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Enter your authenticator code</CardTitle>
          <CardDescription>
            Open your authenticator app and enter the current 6-digit code.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={verifyMfaAction} className="flex flex-col items-center gap-4">
            <InputOTP name="code" maxLength={6} required autoFocus>
              <InputOTPGroup>
                <InputOTPSlot index={0} />
                <InputOTPSlot index={1} />
                <InputOTPSlot index={2} />
                <InputOTPSlot index={3} />
                <InputOTPSlot index={4} />
                <InputOTPSlot index={5} />
              </InputOTPGroup>
            </InputOTP>
            {error === "invalid_code" ? (
              <p role="alert" className="text-sm text-danger">
                That code didn&apos;t verify. Try the current code again.
              </p>
            ) : null}
            <Button type="submit" className="w-full">
              Verify
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
