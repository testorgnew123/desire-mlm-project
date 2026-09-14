import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Building2, CircleAlert } from "lucide-react";
import { getSession } from "@/lib/session";
import { formatDateTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { loginAction } from "./actions";

export const metadata: Metadata = {
  title: "Sign in — Desire",
};

interface LoginSearchParams {
  error?: string;
  until?: string;
}

/** AccountLockedError/InvalidCredentialsError shown inline verbatim, no
 *  generic "something went wrong" -- the error itself travels as a query
 *  param because loginAction redirects rather than returning state, keeping
 *  this page a plain RSC form with no client-side state hook. */
function errorMessage({ error, until }: LoginSearchParams): string | null {
  switch (error) {
    case "missing_fields":
      return "Email and password are required.";
    case "no_org":
      return "No organization is configured.";
    case "invalid_credentials":
      return "Invalid email or password.";
    case "account_locked":
      return until
        ? `Account is locked until ${formatDateTime(until)} IST.`
        : "Account is locked. Try again later.";
    default:
      return null;
  }
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<LoginSearchParams>;
}) {
  const session = await getSession();
  if (session) redirect("/");

  const error = errorMessage(await searchParams);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-muted p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <div className="mb-1 flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Building2 className="size-5" />
          </div>
          <CardTitle>Sign in to Desire</CardTitle>
          <CardDescription>Real estate sales &amp; commission platform</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={loginAction} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" autoComplete="username" required autoFocus />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </div>
            {error ? (
              <p role="alert" className="flex items-start gap-1.5 text-sm text-danger">
                <CircleAlert className="mt-0.5 size-4 shrink-0" />
                {error}
              </p>
            ) : null}
            <Button type="submit" className="w-full">
              Sign in
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
