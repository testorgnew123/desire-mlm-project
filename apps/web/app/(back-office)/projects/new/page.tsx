import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createProjectAction } from "../actions";

export const metadata: Metadata = {
  title: "New project — Desire",
};

export const dynamic = "force-dynamic";

/** A page rather than a card on the list screen: Project carries ~15 settable
 *  fields and squeezing them into a sidebar form is how the payment-plan UI
 *  ended up able to express only one hardcoded milestone.
 *
 *  Only code and name are required -- matching createProject, because a
 *  project in planning has neither a RERA number nor, often, a written-down
 *  address yet. There is NO edit screen for a project yet (updateProject exists
 *  in the service with no caller), so what is left blank here cannot be added
 *  later from the UI; the RERA card says so, because it is the one that blocks
 *  work. */
export default async function NewProjectPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  await requireSession();
  const { error } = await searchParams;

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          nativeButton={false}
          render={<Link href="/projects" aria-label="Back to projects" />}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <h1 className="text-lg font-semibold">New project</h1>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      <form action={createProjectAction} className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Identity</CardTitle>
            <CardDescription>
              The code appears in booking numbers and cannot be changed later.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="code">Project code</Label>
              <Input id="code" name="code" placeholder="SKYLINE" required />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" placeholder="Skyline Residency" required />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Location</CardTitle>
            <CardDescription>
              All optional — a project is often set up before the address is settled.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="city">City</Label>
              <Input id="city" name="city" placeholder="Jaipur" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="state">State</Label>
              <Input id="state" name="state" placeholder="Rajasthan" />
            </div>
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="addressLine1">Address line 1</Label>
              <Input id="addressLine1" name="addressLine1" />
            </div>
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="addressLine2">Address line 2</Label>
              <Input id="addressLine2" name="addressLine2" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pincode">PIN code</Label>
              <Input id="pincode" name="pincode" inputMode="numeric" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>RERA</CardTitle>
            <CardDescription>
              Enter it now if you have it. Plots can&rsquo;t be created, and nothing can be held,
              until the project has a live registration — and there is no screen yet to add one
              afterwards.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="reraRegNo">Registration number</Label>
              <Input id="reraRegNo" name="reraRegNo" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="reraValidTill">Valid till</Label>
              <Input id="reraValidTill" name="reraValidTill" type="date" />
            </div>
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="reraPortalUrl">Portal URL</Label>
              <Input id="reraPortalUrl" name="reraPortalUrl" type="url" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Dates and holds</CardTitle>
            <CardDescription>
              Leave the hold window blank to use the default of 1440 minutes (24 hours).
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="launchDate">Launch date</Label>
              <Input id="launchDate" name="launchDate" type="date" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="expectedPossessionDate">Expected possession</Label>
              <Input id="expectedPossessionDate" name="expectedPossessionDate" type="date" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="holdTtlMinutes">Hold window (minutes)</Label>
              <Input id="holdTtlMinutes" name="holdTtlMinutes" inputMode="numeric" placeholder="1440" />
            </div>
          </CardContent>
        </Card>

        <div className="flex gap-2">
          <Button type="submit">Create project</Button>
          <Button variant="ghost" nativeButton={false} render={<Link href="/projects" />}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
