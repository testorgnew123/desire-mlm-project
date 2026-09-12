import type { Metadata } from "next";
import { redirect } from "next/navigation";
import QRCode from "qrcode";
import { getPrismaClient } from "@desire/db";
import { buildMfaEnrollmentUri, generateMfaSecret } from "@desire/services/auth";
import { readPendingMfaUserId } from "../pending";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { enrollMfaAction } from "./actions";

export const metadata: Metadata = {
  title: "Set up two-factor authentication — Desire",
};

/** Groups a base32 secret into 4-char chunks for manual entry -- the same
 *  spacing every authenticator app's own "enter code manually" screen uses. */
function groupSecret(secret: string): string {
  return secret.replace(/(.{4})/g, "$1 ").trim();
}

export default async function MfaEnrollPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const userId = await readPendingMfaUserId();
  if (!userId) redirect("/login");

  const db = getPrismaClient();
  const user = await db.user.findUnique({ where: { id: userId }, select: { email: true, mfaEnabled: true } });
  if (!user) redirect("/login");
  // Already enrolled -- this pending cookie should have gone to /login/mfa
  // instead. Send them there rather than letting a stale link re-enroll.
  if (user.mfaEnabled) redirect("/login/mfa");

  const { error } = await searchParams;

  // A fresh secret every render -- this page has no server-side state to
  // stash a half-finished enrollment in, so the secret travels with the form
  // itself (hidden field) and the action verifies the code against exactly
  // the secret that produced the QR the user just scanned.
  const secret = generateMfaSecret();
  const enrollmentUri = buildMfaEnrollmentUri(secret, user.email, "Desire");
  const qrSvg = await QRCode.toString(enrollmentUri, { type: "svg", margin: 1, width: 200 });

  return (
    <main className="flex min-h-dvh items-center justify-center bg-muted p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Set up two-factor authentication</CardTitle>
          <CardDescription>
            Your role requires an authenticator app. Scan the QR code, then enter the
            6-digit code it shows.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div
            className="mx-auto [&_svg]:h-auto [&_svg]:w-full [&_svg]:max-w-[200px]"
            // Self-generated SVG from our own QRCode.toString call above --
            // nothing in it is untrusted user input.
            dangerouslySetInnerHTML={{ __html: qrSvg }}
          />
          <p className="text-center text-xs text-muted-foreground">
            Can&apos;t scan? Enter this code manually:{" "}
            <span className="font-mono tracking-wide">{groupSecret(secret)}</span>
          </p>
          <form action={enrollMfaAction} className="flex flex-col items-center gap-4">
            <input type="hidden" name="secret" value={secret} />
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
                That code didn&apos;t verify against the QR above. Rescan the (refreshed)
                code and try again.
              </p>
            ) : null}
            <Button type="submit" className="w-full">
              Verify and enable
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
