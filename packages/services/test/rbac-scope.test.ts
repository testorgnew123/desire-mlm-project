// getAccessibleAssociateIds against a real database tree.
//
// rbac.test.ts covers the PURE resolver (isInScope /
// resolveAccessibleAssociateIds) thoroughly, but nothing covered the
// DB-backed fetch -- which matters now that it no longer loads every
// placement and filters in memory. It asks the database for the actor's
// subtree by path prefix instead (two indexed lookups rather than a
// full-table read, see the comment on getAccessibleAssociateIds).
//
// That is a change to ROW SCOPING, so this does not re-specify the expected
// answer by hand: it uses the well-tested pure resolver as the oracle and
// asserts the database path agrees with it, for every actor in a real tree.
// If the two ever diverge, that is either a leak or a broken screen, and
// this fails.
import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPrismaClient } from "@desire/db";
import { getAccessibleAssociateIds, resolveAccessibleAssociateIds } from "../src/rbac";

const db = getPrismaClient();
const ORG = "org_test_rbac_scope";

interface Placed {
  label: string;
  id: string;
  path: string;
}

const placed: Record<string, Placed> = {};

async function makeAssociate(label: string): Promise<string> {
  const user = await db.user.create({
    data: {
      orgId: ORG,
      email: `${label}-${Date.now()}@scope.test`,
      name: label,
      passwordHash: "x",
    },
  });
  const associate = await db.associate.create({
    data: {
      orgId: ORG,
      userId: user.id,
      code: `A-SCOPE-${label}`,
      engagementType: "EMPLOYEE",
      joinDate: new Date("2024-01-01"),
    },
  });
  return associate.id;
}

/** parentLabel null = root. Path is the full ancestor chain, matching how
 *  associates.ts builds it. */
async function place(label: string, parentLabel: string | null, depth: number): Promise<void> {
  const id = await makeAssociate(label);
  const parent = parentLabel ? placed[parentLabel] : undefined;
  const path = parent ? `${parent.path}${parent.id}/` : "/";
  await db.associateHierarchy.create({
    data: { associateId: id, parentId: parent?.id ?? null, path, depth, validFrom: new Date("2024-01-01") },
  });
  placed[label] = { label, id, path };
}

async function reset() {
  await db.associateHierarchy.deleteMany({ where: { associate: { orgId: ORG } } });
  await db.associate.deleteMany({ where: { orgId: ORG } });
  await db.user.deleteMany({ where: { orgId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

beforeAll(async () => {
  await reset();
  await db.organization.create({
    data: { id: ORG, name: "Scope Test Org", legalName: "Scope Test Org Pvt Ltd" },
  });

  //        ceo
  //       /   \
  //     vp_a   vp_b
  //     /  \      \
  // dir_a  dir_b   dir_c
  //   |
  // rep_a
  await place("ceo", null, 0);
  await place("vp_a", "ceo", 1);
  await place("vp_b", "ceo", 1);
  await place("dir_a", "vp_a", 2);
  await place("dir_b", "vp_a", 2);
  await place("dir_c", "vp_b", 2);
  await place("rep_a", "dir_a", 3);
});

afterAll(async () => {
  await reset();
  await db.$disconnect();
});

describe("getAccessibleAssociateIds (database-backed)", () => {
  it("OWN returns only the actor, without touching the database tree", async () => {
    const result = await getAccessibleAssociateIds(db, placed.ceo!.id, "OWN");
    expect(result).toEqual([placed.ceo!.id]);
  });

  // The important one: same answer as the pure resolver, for EVERY actor.
  it.each(["ceo", "vp_a", "vp_b", "dir_a", "dir_b", "dir_c", "rep_a"])(
    "OWN_AND_DOWNLINE for %s matches the pure resolver exactly",
    async (label) => {
      const actorId = placed[label]!.id;

      const rows = await db.associateHierarchy.findMany({
        where: { validTo: null, associate: { orgId: ORG } },
        select: { associateId: true, path: true },
      });
      const expected = resolveAccessibleAssociateIds(actorId, "OWN_AND_DOWNLINE", rows);

      const actual = await getAccessibleAssociateIds(db, actorId, "OWN_AND_DOWNLINE");

      expect(new Set(actual)).toEqual(new Set(expected));
    },
  );

  it("a leaf sees only itself; a mid-level manager sees its own subtree and no siblings", async () => {
    const leaf = await getAccessibleAssociateIds(db, placed.rep_a!.id, "OWN_AND_DOWNLINE");
    expect(new Set(leaf)).toEqual(new Set([placed.rep_a!.id]));

    const vpA = await getAccessibleAssociateIds(db, placed.vp_a!.id, "OWN_AND_DOWNLINE");
    expect(new Set(vpA)).toEqual(
      new Set([placed.vp_a!.id, placed.dir_a!.id, placed.dir_b!.id, placed.rep_a!.id]),
    );
    // vp_b's branch must not leak into vp_a's scope.
    expect(vpA).not.toContain(placed.vp_b!.id);
    expect(vpA).not.toContain(placed.dir_c!.id);
  });

  it("ignores placements that have been superseded (validTo set)", async () => {
    // Move rep_a out from under dir_a by closing its placement, the way a
    // real tree move does -- the closed row must stop granting scope.
    await db.associateHierarchy.updateMany({
      where: { associateId: placed.rep_a!.id, validTo: null },
      data: { validTo: new Date() },
    });

    const dirA = await getAccessibleAssociateIds(db, placed.dir_a!.id, "OWN_AND_DOWNLINE");
    expect(dirA).not.toContain(placed.rep_a!.id);

    // Restore for any later test ordering.
    await db.associateHierarchy.updateMany({
      where: { associateId: placed.rep_a!.id },
      data: { validTo: null },
    });
  });

  it("an actor with no current placement still sees themselves", async () => {
    const orphanId = await makeAssociate("orphan");
    const result = await getAccessibleAssociateIds(db, orphanId, "OWN_AND_DOWNLINE");
    expect(result).toEqual([orphanId]);
  });
});
