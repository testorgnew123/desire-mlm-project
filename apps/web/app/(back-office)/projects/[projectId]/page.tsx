import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPrismaClient } from "@desire/db";
import { requireSession } from "@/lib/session";
import { formatArea } from "@/lib/money";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  createDraftPriceListAction,
  createPaymentPlanAction,
  createSchemeAction,
  createTowerAction,
  createUnitAction,
  createUnitTypeAction,
  publishPriceListAction,
  publishSchemeAction,
} from "./actions";
import { UnitImportForm } from "./UnitImportForm";

export const metadata: Metadata = {
  title: "Project — Desire",
};

const FIELD_CLASS =
  "h-9 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** Detail, plus Towers / Unit types ("Units") / Price lists / Payment
 *  plans / Commission scheme, all on one page rather than six separate
 *  routes (docs/08-SCREENS.md lists them as one "Projects" section). Live
 *  unit browsing itself stays on the board (Slice 8 links it in) -- "Units"
 *  here is the unit-TYPE catalogue a price list prices against, a project-
 *  configuration concern, not day-to-day inventory monitoring. */
export default async function ProjectDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { projectId } = await params;
  const { error } = await searchParams;
  const session = await requireSession();
  const db = getPrismaClient();

  const project = await db.project.findUnique({
    where: { id: projectId, orgId: session.user.orgId },
    select: { id: true, code: true, name: true, city: true },
  });
  if (!project) notFound();

  const [towers, unitTypes, priceLists, paymentPlans, schemes, grades, plcTagRows] =
    await Promise.all([
    db.tower.findMany({ where: { projectId }, orderBy: { displayOrder: "asc" } }),
    db.unitType.findMany({ where: { projectId }, orderBy: { code: "asc" } }),
    db.priceList.findMany({
      where: { projectId },
      orderBy: { version: "desc" },
      select: { id: true, name: true, version: true, status: true, validFrom: true, _count: { select: { items: true } } },
    }),
    db.paymentPlan.findMany({
      where: { projectId },
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true, _count: { select: { milestones: true } } },
    }),
    db.commissionScheme.findMany({
      where: { projectId },
      orderBy: { version: "desc" },
      select: { id: true, name: true, version: true, status: true, preparedById: true },
    }),
    db.grade.findMany({ where: { orgId: session.user.orgId }, orderBy: { rank: "asc" } }),
    // The price list must price every tag its units carry, or the cost sheet
    // throws UnpricedPlcTagError at quoting time. So the form offers exactly
    // the tags in use rather than a free-text box -- a typo'd "CORNOR" would
    // write a charge no unit can ever match. unnest() because plcTags is a
    // text[] and Prisma has no distinct-over-array-elements.
    db.$queryRaw<Array<{ tag: string }>>`
      SELECT DISTINCT unnest("plcTags") AS tag
      FROM "units"
      WHERE "projectId" = ${projectId}
      ORDER BY tag
    `,
  ]);

  const plcTags = plcTagRows.map((row) => row.tag);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold">{project.name}</h1>
        <p className="text-sm text-muted-foreground">
          {[project.code, project.city].filter(Boolean).join(" · ")}
        </p>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Towers</CardTitle>
            <CardDescription>
              {towers.filter((t) => t.kind === "TOWER").length} tower(s),{" "}
              {towers.filter((t) => t.kind === "BLOCK").length} block(s)
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-col divide-y divide-border">
              {towers.map((tower) => (
                <div key={tower.id} className="flex justify-between py-1.5 text-sm first:pt-0">
                  <span>
                    {tower.code} — {tower.name}
                  </span>
                  <span className="text-muted-foreground">
                    {tower.kind === "BLOCK" ? "Plotted block" : `${tower.totalFloors} floors`}
                  </span>
                </div>
              ))}
            </div>
            {/* One form for both kinds. A project may hold towers AND plotted
                blocks -- a township is the normal case -- which is why `kind`
                sits on the group rather than on the project. Total floors is
                left optional here and enforced by createTower, so the rule
                lives in one place rather than being duplicated in markup. */}
            <form action={createTowerAction} className="flex flex-col gap-2 border-t border-border pt-3">
              <input type="hidden" name="projectId" value={project.id} />
              <div className="flex gap-2">
                <Input name="code" placeholder="Code (e.g. B)" required />
                <Input name="name" placeholder="Name" required />
              </div>
              <div className="flex gap-2">
                <select
                  name="kind"
                  aria-label="Group kind"
                  defaultValue="TOWER"
                  className="h-9 shrink-0 rounded-md border border-border bg-background px-2 text-sm"
                >
                  <option value="TOWER">Tower</option>
                  <option value="BLOCK">Plotted block</option>
                </select>
                <Input
                  name="totalFloors"
                  type="number"
                  min="1"
                  placeholder="Total floors (towers only)"
                />
              </div>
              <Button type="submit" size="sm">
                Add tower or block
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Unit types</CardTitle>
            <CardDescription>{unitTypes.length} type(s)</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-col divide-y divide-border">
              {unitTypes.map((unitType) => (
                <div key={unitType.id} className="py-1.5 text-sm first:pt-0">
                  <p>
                    {unitType.code} — {unitType.name} ({unitType.bedrooms ?? "?"} BHK)
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatArea(unitType.saleableArea, "saleable", unitType.areaBasis)}
                  </p>
                </div>
              ))}
            </div>
            <form action={createUnitTypeAction} className="flex flex-col gap-2 border-t border-border pt-3">
              <input type="hidden" name="projectId" value={project.id} />
              <div className="flex gap-2">
                <Input name="code" placeholder="Code (e.g. 3BHK)" required />
                <Input name="name" placeholder="Name" required />
              </div>
              {/* Same shape as the tower/block form above: one form for both,
                  nothing hidden by script, and createUnitType owns which basis
                  may carry which areas. Carpet and built-up are NOT marked
                  required -- a plot has neither, and SQYD rejects them. */}
              <div className="flex gap-2">
                <Input name="bedrooms" type="number" min="0" placeholder="Bedrooms" />
                <select
                  name="areaBasis"
                  aria-label="Area basis"
                  defaultValue="SQFT"
                  className="h-9 shrink-0 rounded-md border border-border bg-background px-2 text-sm"
                >
                  <option value="SQFT">Built: sq ft</option>
                  <option value="SQYD">Plot: sq yd</option>
                </select>
              </div>
              <div className="flex gap-2">
                <Input name="carpetArea" placeholder="Carpet (built only)" />
                <Input name="builtUpArea" placeholder="Built-up (built only)" />
              </div>
              <Input name="saleableArea" placeholder="Saleable / plot area" required />
              <Button type="submit" size="sm">
                Add unit type
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Units and plots</CardTitle>
            <CardDescription>
              Bulk import is the realistic way to load a township; the single form is for
              corrections afterwards.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {unitTypes.length === 0 ? (
              <p className="text-xs text-muted-foreground">Add a unit type first.</p>
            ) : (
              <>
                <UnitImportForm projectId={project.id} towers={towers} />

                {/* Single-unit entry. Floor is deliberately NOT marked required:
                    a plot in a block must leave it empty, and createUnit
                    enforces which way round it has to be. */}
                <form
                  action={createUnitAction}
                  className="flex flex-col gap-2 border-t border-border pt-3"
                >
                  <input type="hidden" name="projectId" value={project.id} />
                  <div className="flex gap-2">
                    <Input name="unitNumber" placeholder="Unit / plot number" required />
                    <Input name="floor" type="number" placeholder="Floor (towers only)" />
                  </div>
                  <div className="flex gap-2">
                    <select
                      name="towerId"
                      aria-label="Tower or block"
                      className="h-9 flex-1 rounded-md border border-border bg-background px-2 text-sm"
                    >
                      <option value="">No tower or block</option>
                      {towers.map((tower) => (
                        <option key={tower.id} value={tower.id}>
                          {tower.code} — {tower.kind === "BLOCK" ? "block" : "tower"}
                        </option>
                      ))}
                    </select>
                    <select
                      name="unitTypeId"
                      aria-label="Unit type"
                      required
                      className="h-9 flex-1 rounded-md border border-border bg-background px-2 text-sm"
                    >
                      {unitTypes.map((unitType) => (
                        <option key={unitType.id} value={unitType.id}>
                          {unitType.code}
                        </option>
                      ))}
                    </select>
                  </div>
                  <Button type="submit" size="sm">
                    Add one unit or plot
                  </Button>
                </form>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Price lists</CardTitle>
            <CardDescription>{priceLists.length} version(s)</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-col divide-y divide-border">
              {priceLists.map((priceList) => (
                <div key={priceList.id} className="flex items-center justify-between py-1.5 text-sm first:pt-0">
                  <span>
                    v{priceList.version} — {priceList.name} (
                    <Badge variant="secondary">{priceList.status.replaceAll("_", " ")}</Badge>, {priceList._count.items}{" "}
                    item(s))
                  </span>
                  {priceList.status === "DRAFT" || priceList.status === "PENDING_APPROVAL" ? (
                    <form action={publishPriceListAction}>
                      <input type="hidden" name="projectId" value={project.id} />
                      <input type="hidden" name="priceListId" value={priceList.id} />
                      <Button type="submit" size="xs" variant="outline">
                        Publish
                      </Button>
                    </form>
                  ) : null}
                </div>
              ))}
            </div>
            {unitTypes.length === 0 ? (
              <p className="text-xs text-muted-foreground">Add a unit type first.</p>
            ) : (
              <form action={createDraftPriceListAction} className="flex flex-col gap-2 border-t border-border pt-3">
                <input type="hidden" name="projectId" value={project.id} />
                <Input name="name" placeholder="Price list name (e.g. Launch pricing)" required />
                {unitTypes.map((unitType) => (
                  <div key={unitType.id} className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-2">
                      <Label className="w-24 shrink-0 text-xs">{unitType.code}</Label>
                      <input type="hidden" name="unitTypeId" value={unitType.id} />
                      <Input
                        name={`rate_${unitType.id}`}
                        placeholder={
                          unitType.areaBasis === "SQYD" ? "Rate per sq yd" : "Rate per sq ft"
                        }
                      />
                    </div>
                    {/* One row per PLC tag the project's units actually carry.
                        A corner plot's DLC uplift is "% of base" with a value
                        of 10; a park-facing flat is more often a rupee figure
                        per unit of area. Left blank, the tag is simply not
                        priced for this type -- which is NOT the same as zero,
                        and the cost sheet will refuse to quote a unit whose
                        tag has no charge rather than quote it at nothing. */}
                    {plcTags.map((tag) => (
                      <div key={tag} className="flex items-center gap-2 pl-4">
                        <Label
                          title={tag}
                          className="w-24 shrink-0 truncate text-xs text-muted-foreground"
                        >
                          {tag}
                        </Label>
                        <input type="hidden" name={`plcTag_${unitType.id}`} value={tag} />
                        {/* PER_AREA first and selected by default: it is what
                            every price list written so far means, so a number
                            typed without touching this keeps its old meaning. */}
                        <select
                          name={`plcBasis_${unitType.id}`}
                          aria-label={`${tag} charge basis for ${unitType.code}`}
                          defaultValue="PER_AREA"
                          className="h-9 w-32 shrink-0 rounded-md border border-border bg-background px-2 text-sm"
                        >
                          <option value="PER_AREA">
                            ₹ per {unitType.areaBasis === "SQYD" ? "sq yd" : "sq ft"}
                          </option>
                          <option value="PCT_OF_BASE">% of base</option>
                        </select>
                        <Input
                          name={`plcValue_${unitType.id}`}
                          aria-label={`${tag} charge for ${unitType.code}`}
                          placeholder="Blank = not priced"
                        />
                      </div>
                    ))}
                  </div>
                ))}
                {plcTags.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No PLC tags on this project&rsquo;s units yet. Tag units CORNER, PARK_FACING
                    and so on when importing them, and each tag gets a rate here.
                  </p>
                ) : null}
                <Button type="submit" size="sm">
                  Create draft price list
                </Button>
              </form>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Payment plans</CardTitle>
            <CardDescription>{paymentPlans.length} plan(s)</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-col divide-y divide-border">
              {paymentPlans.map((plan) => (
                <div key={plan.id} className="flex justify-between py-1.5 text-sm first:pt-0">
                  <span>
                    {plan.code} — {plan.name}
                  </span>
                  <span className="text-muted-foreground">{plan._count.milestones} milestone(s)</span>
                </div>
              ))}
            </div>
            <form action={createPaymentPlanAction} className="flex flex-col gap-2 border-t border-border pt-3">
              <input type="hidden" name="projectId" value={project.id} />
              <div className="flex gap-2">
                <Input name="code" placeholder="Code (e.g. FULL-PAY)" required />
                <Input name="name" placeholder="Name" required />
              </div>
              <p className="text-xs text-muted-foreground">
                Created with a single 100% "on booking" milestone -- editing milestones lands in a later slice.
              </p>
              <Button type="submit" size="sm">
                Add payment plan
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Commission scheme</CardTitle>
          <CardDescription>{schemes.length} version(s)</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-col divide-y divide-border">
            {schemes.map((scheme) => (
              <div key={scheme.id} className="flex items-center justify-between py-1.5 text-sm first:pt-0">
                <span>
                  v{scheme.version} — {scheme.name} (<Badge variant="secondary">{scheme.status.replaceAll("_", " ")}</Badge>)
                </span>
                {scheme.status === "DRAFT" || scheme.status === "PENDING_APPROVAL" ? (
                  <form action={publishSchemeAction}>
                    <input type="hidden" name="projectId" value={project.id} />
                    <input type="hidden" name="schemeId" value={scheme.id} />
                    <Button type="submit" size="xs" variant="outline">
                      Publish
                    </Button>
                  </form>
                ) : null}
              </div>
            ))}
          </div>
          <form action={createSchemeAction} className="flex flex-col gap-3 border-t border-border pt-3">
            <input type="hidden" name="projectId" value={project.id} />
            <div className="flex gap-2">
              <Input name="name" placeholder="Scheme name (e.g. Skyline Phase 2)" required />
              <Input name="maxTotalPct" placeholder="Max total % (e.g. 3)" defaultValue="3" />
            </div>
            <p className="text-xs font-medium">Grade rates (% of base, self commission)</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {grades.map((grade) => (
                <div key={grade.id} className="flex items-center gap-2">
                  <Label className="w-10 shrink-0 text-xs">{grade.code}</Label>
                  <input type="hidden" name="gradeId" value={grade.id} />
                  <Input name={`gradeRate_${grade.id}`} placeholder="%" className={FIELD_CLASS} />
                </div>
              ))}
            </div>
            <p className="text-xs font-medium">Override level rates (% of seller commission, levels 1-3)</p>
            <div className="grid grid-cols-3 gap-2">
              {[1, 2, 3].map((level) => (
                <div key={level} className="flex items-center gap-2">
                  <Label className="w-6 shrink-0 text-xs">L{level}</Label>
                  <Input name={`levelRate_${level}`} placeholder="%" />
                </div>
              ))}
            </div>
            <Button type="submit" size="sm" className="self-start">
              Create draft scheme
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
