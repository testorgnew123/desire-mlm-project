import type {
  GradeAssignmentRecord,
  OrgSnapshot,
  ResolvedUplineNode,
} from "./types";

function isInForce(validFrom: string, validTo: string | null, asOfDate: string): boolean {
  return validFrom <= asOfDate && (validTo === null || asOfDate < validTo);
}

/** Resolves which grade assignment was in force on `asOfDate`, from one
 *  associate's full effective-dated history. Pure -- the caller fetches the
 *  history; this never queries a database.
 *
 *  This is the core of the reproducibility guarantee: promoting someone today
 *  only APPENDS a new record with a new validFrom. It never edits or removes
 *  the old one, so resolving "as of" a past booking date against the (now
 *  longer) history still finds the original record. See
 *  docs/04-COMMISSION-SPEC.md section 2 and ADR-0003. */
export function gradeAsOf(
  history: readonly GradeAssignmentRecord[],
  asOfDate: string,
): GradeAssignmentRecord | undefined {
  return history.find((g) => isInForce(g.validFrom, g.validTo, asOfDate));
}

/** Walks the hierarchy upward from `sellerAssociateId`, resolving each
 *  ancestor's identity, grade and code as they stood on `asOfDate` -- up to
 *  `maxLevel` or until the chain runs out. Same reproducibility guarantee as
 *  gradeAsOf: a tree restructure appends new hierarchy rows, it does not
 *  rewrite history.
 *
 *  Stops (rather than fabricating a node) if an ancestor's grade or identity
 *  cannot be resolved as of the date -- a data gap must never be silently
 *  papered over in a commission computation. */
export function uplineChainAsOf(
  sellerAssociateId: string,
  asOfDate: string,
  maxLevel: number,
  org: OrgSnapshot,
): ResolvedUplineNode[] {
  const chain: ResolvedUplineNode[] = [];
  let currentId = sellerAssociateId;

  for (let level = 1; level <= maxLevel; level++) {
    const hierarchy = org.hierarchyHistory.get(currentId) ?? [];
    const inForce = hierarchy.find((h) => isInForce(h.validFrom, h.validTo, asOfDate));
    const parentId = inForce?.parentAssociateId ?? null;
    if (parentId === null) break;

    const parentGrade = gradeAsOf(org.gradeHistory.get(parentId) ?? [], asOfDate);
    const parentInfo = org.associates.get(parentId);
    if (!parentGrade || !parentInfo) break;

    chain.push({
      level,
      associateId: parentId,
      code: parentInfo.code,
      gradeCode: parentGrade.gradeCode,
      gradeRank: parentGrade.gradeRank,
      status: parentInfo.status,
    });
    currentId = parentId;
  }

  return chain;
}
