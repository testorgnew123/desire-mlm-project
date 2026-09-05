import Decimal from "decimal.js";
import { CommissionSchemeMisconfiguredError } from "./errors";
import { round2 } from "./round";
import { gradeAsOf, uplineChainAsOf } from "./resolve";
import type {
  AccrualInput,
  AccrualResult,
  CommissionEntryResult,
  GradeRate,
  OrgSnapshot,
  ResolvedUplineNode,
  SchemeConfig,
} from "./types";

function applyGradeRate(rate: GradeRate, base: Decimal, saleableArea: Decimal): Decimal {
  switch (rate.rateType) {
    case "PCT_OF_BASE":
      return base.mul(rate.rateValue).div(100);
    case "PER_SQFT":
      return saleableArea.mul(rate.rateValue);
    case "FLAT":
      return rate.rateValue;
  }
}

/** Associate.status has no history in the schema, so this checks CURRENT
 *  status regardless of bookingDate -- a documented limitation, not a bug.
 *  See types.ts AssociateSnapshot and docs/04-COMMISSION-SPEC.md section 3. */
function isEligible(node: ResolvedUplineNode, scheme: SchemeConfig): boolean {
  if (node.status !== "ACTIVE") return false;
  const rules = scheme.eligibilityRules;
  if (rules?.minGradeRank !== undefined && node.gradeRank < rules.minGradeRank) {
    return false;
  }
  return true;
}

/**
 * Accrues self commission and level overrides for one booking, following
 * docs/04-COMMISSION-SPEC.md sections 1-3.
 *
 * Compression, precisely:
 *   NONE    -- an ineligible holder's level is consumed immediately; the
 *              amount becomes breakage. The level is never re-offered.
 *   ROLL_UP -- an ineligible holder's level is NOT consumed. The percentage
 *              walks up the chain to the next upline, checked for
 *              eligibility in turn, until someone qualifies or the chain
 *              runs out (at which point it becomes breakage after all, since
 *              there is nobody left to roll to).
 *
 * Under ROLL_UP the entry's `level` field always records the level the
 * payout REPRESENTS, not the beneficiary's actual tree depth -- a level-2
 * associate who receives a rolled-up level-1 override gets two separate
 * entries (level 1 and level 2), which is what the explain drill-down shows.
 *
 * Refuses to return (throws) if the total would exceed the scheme's
 * maxTotalPct ceiling -- see docs/04-COMMISSION-SPEC.md section 7.
 */
export function accrue(input: AccrualInput, org: OrgSnapshot): AccrualResult {
  const { scheme, bookingId, bookingDate, commissionableValue, saleableAreaAtBooking, seller } =
    input;

  const sellerGrade = gradeAsOf(org.gradeHistory.get(seller.associateId) ?? [], bookingDate);
  if (!sellerGrade) {
    throw new CommissionSchemeMisconfiguredError(
      `No grade assignment found for seller ${seller.associateId} as of ${bookingDate}`,
      { bookingId, associateId: seller.associateId, bookingDate },
    );
  }

  const gradeRate = scheme.gradeRates.find((r) => r.gradeCode === sellerGrade.gradeCode);
  if (!gradeRate) {
    throw new CommissionSchemeMisconfiguredError(
      `Scheme ${scheme.schemeId} v${scheme.schemeVersion} has no rate for grade ${sellerGrade.gradeCode}`,
      { bookingId, schemeId: scheme.schemeId, gradeCode: sellerGrade.gradeCode },
    );
  }

  const selfAmt = round2(
    applyGradeRate(gradeRate, commissionableValue, saleableAreaAtBooking),
  );

  const uplineChain = uplineChainAsOf(seller.associateId, bookingDate, scheme.maxLevel, org);
  const snapshotChain = uplineChain.map((n) => ({
    level: n.level,
    associateId: n.associateId,
    code: n.code,
    gradeCode: n.gradeCode,
  }));

  const entries: CommissionEntryResult[] = [
    {
      bookingId,
      schemeId: scheme.schemeId,
      beneficiaryAssociateId: seller.associateId,
      role: "SELF",
      level: 0,
      baseAmount: commissionableValue,
      grossAmount: selfAmt,
      idempotencyKey: `${bookingId}:${seller.associateId}:0:${scheme.schemeId}`,
      snapshot: {
        gradeCode: sellerGrade.gradeCode,
        gradeRank: sellerGrade.gradeRank,
        rateType: gradeRate.rateType,
        rateValue: gradeRate.rateValue.toString(),
        sellerCommission: selfAmt.toString(),
        uplineChain: snapshotChain,
        schemeVersion: scheme.schemeVersion,
        compressionMode: scheme.compressionMode,
        computedAt: input.computedAt,
      },
    },
  ];

  let breakage = new Decimal(0);

  for (const levelRate of scheme.levelRates) {
    const { level, pctOfSellerCommission: pct } = levelRate;
    if (pct.isZero()) continue;

    // No candidate exists at this level AT ALL (the chain simply doesn't
    // reach this far) -- distinct from "a candidate exists but is
    // ineligible". A short chain must not manufacture breakage for levels
    // that were never occupied by anyone; there is no unclaimed money here,
    // because nobody was ever entitled to a slot that doesn't exist.
    if (level > uplineChain.length) continue;

    const overrideAmt = round2(selfAmt.mul(pct).div(100));
    let placed = false;
    let candidateLevel = level;

    while (candidateLevel <= uplineChain.length) {
      // Safe by construction: the while condition guarantees candidateLevel
      // is within [1, uplineChain.length] on every iteration, so this index
      // is always in bounds. (A prior defensive undefined-check here was
      // dead code -- unreachable once the level > uplineChain.length guard
      // above exists -- and was removed rather than kept just to satisfy a
      // coverage tool with an impossible branch.)
      const candidate = uplineChain[candidateLevel - 1]!;

      if (isEligible(candidate, scheme)) {
        entries.push({
          bookingId,
          schemeId: scheme.schemeId,
          beneficiaryAssociateId: candidate.associateId,
          role: "OVERRIDE",
          level,
          baseAmount: commissionableValue,
          grossAmount: overrideAmt,
          idempotencyKey: `${bookingId}:${candidate.associateId}:${level}:${scheme.schemeId}`,
          snapshot: {
            gradeCode: candidate.gradeCode,
            gradeRank: candidate.gradeRank,
            rateType: gradeRate.rateType,
            rateValue: gradeRate.rateValue.toString(),
            sellerCommission: selfAmt.toString(),
            levelPct: pct.toString(),
            uplineChain: snapshotChain,
            schemeVersion: scheme.schemeVersion,
            compressionMode: scheme.compressionMode,
            computedAt: input.computedAt,
          },
        });
        placed = true;
        break;
      }

      if (scheme.compressionMode === "NONE") {
        breakage = breakage.plus(overrideAmt);
        placed = true; // consumed, as breakage -- not re-offered
        break;
      }

      // ROLL_UP: not consumed. Offer the same percentage to the next upline.
      candidateLevel += 1;
    }

    if (!placed) {
      // ROLL_UP walked off the end of the chain with nobody eligible.
      // Nobody left to roll to -- it becomes breakage after all.
      breakage = breakage.plus(overrideAmt);
    }
  }

  const totalGross = entries.reduce((sum, e) => sum.plus(e.grossAmount), new Decimal(0));
  const ceiling = commissionableValue.mul(scheme.maxTotalPct).div(100);
  if (totalGross.greaterThan(ceiling)) {
    throw new CommissionSchemeMisconfiguredError(
      `Scheme ${scheme.schemeId} v${scheme.schemeVersion} would pay out ${totalGross.toString()}, ` +
        `exceeding the maxTotalPct ceiling of ${ceiling.toString()} for booking ${bookingId}. ` +
        `Refusing to accrue -- fix the scheme before retrying.`,
      {
        bookingId,
        schemeId: scheme.schemeId,
        totalGross: totalGross.toString(),
        ceiling: ceiling.toString(),
      },
    );
  }

  return { entries, breakage };
}
