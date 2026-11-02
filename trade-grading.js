// Trade grading shared by the live trade posts (index.js) and the `!trade`
// chat command, so a hypothetical trade grades exactly like the real one would.

// Summing raw values treats a trade as a pile of assets, but dynasty rosters
// have finite starting slots — consolidating three good pieces into one great
// one is worth more than the sums say. KeepTradeCut's own calculator models
// this with an explicit "value adjustment" on whichever side receives fewer
// pieces (~27% of that side's bundle per surplus piece, back-solved from its
// posted numbers). Grading raw sums without it handed an F to trades KTC
// itself calls fair.
const CONSOLIDATION_PREMIUM_RATE = 0.27;
// A 5-for-1 shouldn't earn a 135% bonus, so cap the multiplier.
const CONSOLIDATION_PREMIUM_MAX = 0.6;

// The premium belongs to the *bundle*, not to one team's point of view: the
// two-piece side of this trade is worth more than its sum no matter which team
// is being graded. Applying it only to what a team received would grade the
// same trade C for one side and A for the other.
export function computeConsolidationBonus({ ownCount, otherCount, bundleValue }) {
  const pieceGap = (otherCount ?? 0) - (ownCount ?? 0);
  if (pieceGap <= 0 || !(bundleValue > 0)) {
    return 0;
  }

  const rate = Math.min(
    CONSOLIDATION_PREMIUM_RATE * pieceGap,
    CONSOLIDATION_PREMIUM_MAX
  );
  return Math.round(bundleValue * rate);
}

// Six evenly-spaced tiers. The old nine-tier ladder was lopsided — -0.25 earned
// an F while +0.25 earned only an A- — so an ordinary losing side graded like a
// disaster. C straddles zero and is the "fair trade" band.
// The score is a *differential* — who won and by how much — and it is zero-sum,
// so the two sides' scores always sum to zero. Rendering that through school
// letters made the middle band read as an insult: a perfectly fair trade, which
// is the ideal outcome of a negotiation, came out "C" for both sides, and the
// best shared result the scale can express is "both average". The letters stay
// as the stored classification (trade-history, awards, the card pill); the post
// itself now shows these verdicts, so an even trade reads as even rather than
// mediocre. Thresholds and math are unchanged.
export const GRADE_TIERS = [
  { min: 0.3, grade: "A", gradeFlavor: "elite", gradeLabel: "Heist" },
  { min: 0.12, grade: "B", gradeFlavor: "good", gradeLabel: "Came out ahead" },
  { min: -0.12, grade: "C", gradeFlavor: "neutral", gradeLabel: "Even swap" },
  { min: -0.3, grade: "D", gradeFlavor: "bad", gradeLabel: "Came out behind" },
  { min: -0.5, grade: "E", gradeFlavor: "bad", gradeLabel: "Got fleeced" },
];

// Takes consolidation-adjusted values; the caller owns that adjustment.
export function buildTradeGrade({ sentValue, receivedValue, knownValueCount }) {
  if (!knownValueCount) {
    return {
      grade: "N/A",
      gradeFlavor: "neutral",
      gradeLabel: "Unrated",
      score: 0,
    };
  }

  const baseline = Math.max((sentValue + receivedValue) / 2, 1);
  const score = (receivedValue - sentValue) / baseline;
  const tier = GRADE_TIERS.find((candidate) => score >= candidate.min);

  if (!tier) {
    return {
      grade: "F",
      gradeFlavor: "bad",
      gradeLabel: "Robbed blind",
      score,
    };
  }

  return {
    grade: tier.grade,
    gradeFlavor: tier.gradeFlavor,
    gradeLabel: tier.gradeLabel,
    score,
  };
}

// Grades one side of a two-way swap: what it sent vs what it received, with the
// consolidation premium applied to whichever bundle has fewer pieces. Counts
// should only include assets with a known value — an ungraded throw-in must
// not inflate the piece gap and buy a bonus.
export function gradeSwap({ sentValue, receivedValue, sentCount, receivedCount, knownValueCount }) {
  const receivedConsolidationBonus = computeConsolidationBonus({
    ownCount: receivedCount,
    otherCount: sentCount,
    bundleValue: receivedValue,
  });
  const sentConsolidationBonus = computeConsolidationBonus({
    ownCount: sentCount,
    otherCount: receivedCount,
    bundleValue: sentValue,
  });
  const adjustedReceivedValue = receivedValue + receivedConsolidationBonus;
  const adjustedSentValue = sentValue + sentConsolidationBonus;
  const gradeData = buildTradeGrade({
    sentValue: adjustedSentValue,
    receivedValue: adjustedReceivedValue,
    knownValueCount,
  });

  return {
    receivedConsolidationBonus,
    sentConsolidationBonus,
    rawNetValue: receivedValue - sentValue,
    netValue: adjustedReceivedValue - adjustedSentValue,
    ...gradeData,
  };
}
