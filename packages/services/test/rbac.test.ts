// The scope resolver is the one thing docs/09-RBAC-MATRIX.md insists must be
// a single, well-tested function -- an ad-hoc `where` clause copied into a
// new query is how another team's earnings eventually leak into a report.
import { describe, expect, it } from "vitest";
import { isInScope, resolveAccessibleAssociateIds, type HierarchyPathRow } from "../src/rbac";

// A 6-level deep tree, matching the target scale in docs/12-NFR.md (tree
// depth <= 8). Path convention: each row's OWN ancestor chain, not including
// itself -- see the comment block atop rbac.ts.
//
//            ceo (path "/")
//             |
//            vp  (path "/ceo/")
//           /    \
//      dir_a      dir_b   (path "/ceo/vp/")
//        |           |
//     mgr_a       mgr_b   (path "/ceo/vp/dir_a/" or ".../dir_b/")
//       |            |
//    lead_a       lead_b  (path "/ceo/vp/dir_a/mgr_a/" or ".../mgr_b/")
//       |
//     rep_a                (path "/ceo/vp/dir_a/mgr_a/lead_a/")
const DEEP_TREE: HierarchyPathRow[] = [
  { associateId: "ceo", path: "/" },
  { associateId: "vp", path: "/ceo/" },
  { associateId: "dir_a", path: "/ceo/vp/" },
  { associateId: "dir_b", path: "/ceo/vp/" },
  { associateId: "mgr_a", path: "/ceo/vp/dir_a/" },
  { associateId: "mgr_b", path: "/ceo/vp/dir_b/" },
  { associateId: "lead_a", path: "/ceo/vp/dir_a/mgr_a/" },
  { associateId: "lead_b", path: "/ceo/vp/dir_b/mgr_b/" },
  { associateId: "rep_a", path: "/ceo/vp/dir_a/mgr_a/lead_a/" },
];

describe("isInScope", () => {
  it("an associate is always in their own scope", () => {
    expect(isInScope("mgr_a", { associateId: "mgr_a", path: "/ceo/vp/dir_a/" })).toBe(true);
  });

  it("a direct child is in scope", () => {
    expect(isInScope("mgr_a", { associateId: "lead_a", path: "/ceo/vp/dir_a/mgr_a/" })).toBe(true);
  });

  it("a grandchild (multiple levels down) is in scope", () => {
    expect(isInScope("mgr_a", { associateId: "rep_a", path: "/ceo/vp/dir_a/mgr_a/lead_a/" })).toBe(
      true,
    );
  });

  it("a sibling's subtree is NOT in scope", () => {
    expect(isInScope("mgr_a", { associateId: "lead_b", path: "/ceo/vp/dir_b/mgr_b/" })).toBe(false);
  });

  it("an ancestor is NOT in the descendant's scope (scope is downward-only)", () => {
    expect(isInScope("rep_a", { associateId: "mgr_a", path: "/ceo/vp/dir_a/" })).toBe(false);
  });

  it("a node with a similar-looking but distinct id is not falsely matched", () => {
    // Guards against a naive substring check matching "mgr_a" inside
    // "mgr_ab" or similar -- the /X/ delimiter framing in isInScope is what
    // prevents this, and this test is what proves the framing works.
    const trickyTree: HierarchyPathRow = { associateId: "trap", path: "/ceo/vp/dir_ax/" };
    expect(isInScope("dir_a", trickyTree)).toBe(false);
  });
});

describe("resolveAccessibleAssociateIds", () => {
  it("OWN mode returns exactly the actor, regardless of tree shape", () => {
    expect(resolveAccessibleAssociateIds("mgr_a", "OWN", DEEP_TREE)).toEqual(["mgr_a"]);
  });

  it("OWN_AND_DOWNLINE from mid-tree includes self and every descendant, excludes everyone else", () => {
    const result = resolveAccessibleAssociateIds("dir_a", "OWN_AND_DOWNLINE", DEEP_TREE);

    expect(result).toEqual(expect.arrayContaining(["dir_a", "mgr_a", "lead_a", "rep_a"]));
    expect(result).not.toContain("dir_b");
    expect(result).not.toContain("mgr_b");
    expect(result).not.toContain("lead_b");
    expect(result).not.toContain("vp");
    expect(result).not.toContain("ceo");
    expect(result).toHaveLength(4);
  });

  it("OWN_AND_DOWNLINE from the root sees the entire tree", () => {
    const result = resolveAccessibleAssociateIds("ceo", "OWN_AND_DOWNLINE", DEEP_TREE);
    expect(result).toHaveLength(DEEP_TREE.length);
  });

  it("OWN_AND_DOWNLINE from a leaf sees only themself", () => {
    const result = resolveAccessibleAssociateIds("rep_a", "OWN_AND_DOWNLINE", DEEP_TREE);
    expect(result).toEqual(["rep_a"]);
  });

  it("includes the actor even if they are somehow missing from the placement list", () => {
    const incompleteTree = DEEP_TREE.filter((r) => r.associateId !== "mgr_a");
    const result = resolveAccessibleAssociateIds("mgr_a", "OWN_AND_DOWNLINE", incompleteTree);
    expect(result).toContain("mgr_a");
    expect(result).toEqual(expect.arrayContaining(["mgr_a", "lead_a", "rep_a"]));
  });
});
