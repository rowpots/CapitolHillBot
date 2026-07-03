// Analytics engine: dynasty-value roster profiling + a mutually-beneficial
// trade finder. Pure and source-agnostic — every function operates over
// already-loaded Sleeper data (rosters/users/players) plus a value book
// (`getPlayerValue` / `getPickValue`), so it works identically under
// DynastyProcess or KeepTradeCut and makes NO network calls itself. Callers
// (preview-roster-analysis.js today, chat commands in a later phase) load the
// data and pass it in.
import {
  buildRosterLookup,
  buildUserLookup,
  formatRosterLabel,
} from "./weekly-report.js";

// The offensive skill positions we model for need/surplus + the trade finder.
// K/DEF carry no dynasty value in either source, so they're excluded on purpose.
export const CORE_POSITIONS = ["QB", "RB", "WR", "TE"];

// A team's positional value below this fraction of the league average at a
// position counts as a "need"; at or above the surplus fraction counts as a
// "surplus". Deliberately loose so a 12-team league surfaces candidate pairs;
// the fairness band + idea ranking below do the real filtering.
const NEED_RATIO = 0.9;
const SURPLUS_RATIO = 1.1;

// Fairness band for a proposed swap, using the same (received - sent)/baseline
// score as the live trade grader (index.js buildTradeGrade). 0.10 keeps every
// suggestion inside the C/B "basically even" range — the finder proposes fair
// deals, never a fleecing.
const FAIRNESS_BAND = 0.1;

// Value-weighted average age cutoffs for the win-now vs rebuild tilt (measured
// over a roster's most valuable "starter" tier only — depth skews old/young).
const WIN_NOW_AGE = 27;
const REBUILD_AGE = 24.5;

// Fallback when a league's roster_positions can't be read; a typical dynasty
// starting lineup (QB/2RB/2-3WR/TE/FLEX/SUPERFLEX-ish) lands around here.
const DEFAULT_STARTING_SLOTS = 9;
const NON_STARTER_SLOTS = new Set(["BN", "IR", "TAXI"]);

// Count of starting lineup slots for a league, i.e. roster_positions minus the
// bench/IR/taxi slots. Exported so callers derive "starters" consistently.
export function countStartingSlots(league) {
  const positions = Array.isArray(league?.roster_positions)
    ? league.roster_positions
    : [];
  const starterSlots = positions.filter(
    (slot) => !NON_STARTER_SLOTS.has(String(slot).toUpperCase())
  );
  return starterSlots.length > 0 ? starterSlots.length : DEFAULT_STARTING_SLOTS;
}

// Per-roster dynasty-value profile: total value, positional breakdown, a
// starter-vs-depth split (top `startingSlots` by value = "starters"), and an
// age-weighted win-now/rebuild tilt. `players` is sorted by value descending.
export function buildRosterValuations({
  rosters,
  users,
  playersById,
  valueBook,
  league = null,
}) {
  const rosterLookup = buildRosterLookup(rosters ?? []);
  const userLookup = buildUserLookup(users ?? []);
  const startingSlots = countStartingSlots(league);

  return (rosters ?? []).map((roster) => {
    const rosterId = String(roster.roster_id);
    const label = formatRosterLabel(rosterId, rosterLookup, userLookup);

    const players = [];
    for (const playerId of roster.players ?? []) {
      const player = playersById?.[playerId];
      if (!player) {
        continue;
      }

      const rawValue = valueBook?.getPlayerValue(player);
      const value = Number.isFinite(rawValue) ? rawValue : 0;
      const name =
        player.full_name ||
        [player.first_name, player.last_name].filter(Boolean).join(" ") ||
        `Player ${playerId}`;
      const age = Number.isFinite(Number(player.age)) ? Number(player.age) : null;

      players.push({
        id: String(playerId),
        name,
        position: String(player.position ?? "").toUpperCase(),
        team: player.team ?? null,
        value,
        age,
      });
    }

    players.sort((a, b) => b.value - a.value);

    const byPosition = Object.fromEntries(CORE_POSITIONS.map((pos) => [pos, 0]));
    let totalValue = 0;
    for (const player of players) {
      totalValue += player.value;
      if (byPosition[player.position] != null) {
        byPosition[player.position] += player.value;
      }
    }

    const starters = players.slice(0, startingSlots);
    const depth = players.slice(startingSlots);
    const starterValue = sumValue(starters);
    const depthValue = sumValue(depth);

    return {
      rosterId,
      label,
      players,
      totalValue,
      byPosition,
      starterValue,
      depthValue,
      startingSlots,
      tilt: computeTilt(starters),
    };
  });
}

// Value-weighted average age of the starter tier → a win-now/rebuild label.
// Players without an age (e.g. DEF) or without value are skipped.
function computeTilt(players) {
  let weightedAge = 0;
  let weight = 0;
  for (const player of players) {
    if (player.age == null || !(player.value > 0)) {
      continue;
    }
    weightedAge += player.age * player.value;
    weight += player.value;
  }

  const avgAge = weight > 0 ? weightedAge / weight : null;
  let label = "balanced";
  if (avgAge != null) {
    if (avgAge >= WIN_NOW_AGE) {
      label = "win-now";
    } else if (avgAge <= REBUILD_AGE) {
      label = "rebuild";
    }
  }

  return { avgAge, label };
}

// Dynasty-value leaderboard — distinct from the PPG-based power rankings. Adds
// `rank` (1 = most valuable) and `share` (fraction of total league value).
export function rankRosters(valuations) {
  const sorted = [...valuations].sort((a, b) => b.totalValue - a.totalValue);
  const leagueTotal = sorted.reduce((sum, entry) => sum + entry.totalValue, 0);

  return sorted.map((entry, index) => ({
    ...entry,
    rank: index + 1,
    share: leagueTotal > 0 ? entry.totalValue / leagueTotal : 0,
  }));
}

// For each team: which core positions are below the league average (needs) and
// which are above it (surpluses), each ranked by the size of the value gap.
function computePositionalProfiles(valuations) {
  const leagueAvg = {};
  for (const pos of CORE_POSITIONS) {
    const total = valuations.reduce(
      (sum, entry) => sum + (entry.byPosition[pos] ?? 0),
      0
    );
    leagueAvg[pos] = valuations.length > 0 ? total / valuations.length : 0;
  }

  const profiles = new Map();
  for (const entry of valuations) {
    const needs = [];
    const surpluses = [];

    for (const pos of CORE_POSITIONS) {
      const avg = leagueAvg[pos];
      if (avg <= 0) {
        continue;
      }

      const teamValue = entry.byPosition[pos] ?? 0;
      const ratio = teamValue / avg;
      if (ratio <= NEED_RATIO) {
        needs.push({ pos, ratio, gap: avg - teamValue });
      } else if (ratio >= SURPLUS_RATIO) {
        surpluses.push({ pos, ratio, gap: teamValue - avg });
      }
    }

    needs.sort((a, b) => b.gap - a.gap);
    surpluses.sort((a, b) => b.gap - a.gap);
    profiles.set(entry.rosterId, { needs, surpluses });
  }

  return { leagueAvg, profiles };
}

// The trade finder. Pairs every two rosters and proposes swaps where each side
// ships from a position it's deep at (its surplus, which is the other team's
// need) and receives at a position it's thin at — net value inside the fairness
// band. Returns the top-N ideas across the league, ranked by combined need
// relief (with fairness + deal size as tie-breakers). Each idea includes both
// packages and the value math so callers can render a rationale.
export function findTrades({ valuations, options = {} }) {
  const maxIdeas = options.maxIdeas ?? 8;
  const maxPerPair = options.maxPerPair ?? 1;
  const fairnessBand = options.fairnessBand ?? FAIRNESS_BAND;
  const minAssetValue = options.minAssetValue ?? 0;

  const { profiles } = computePositionalProfiles(valuations);
  const ideas = [];

  for (let i = 0; i < valuations.length; i += 1) {
    for (let j = i + 1; j < valuations.length; j += 1) {
      const pairIdeas = findTradesForPair(
        valuations[i],
        valuations[j],
        profiles,
        { fairnessBand, minAssetValue }
      );
      pairIdeas.sort((a, b) => b.score - a.score);
      ideas.push(...pairIdeas.slice(0, maxPerPair));
    }
  }

  ideas.sort((a, b) => b.score - a.score);
  return ideas.slice(0, maxIdeas);
}

function findTradesForPair(a, b, profiles, opts) {
  const profileA = profiles.get(a.rosterId);
  const profileB = profiles.get(b.rosterId);
  if (!profileA || !profileB) {
    return [];
  }

  const ideas = [];
  // A ships at posFromA (its surplus / B's need) and receives at posFromB (B's
  // surplus / A's need) — the classic "you're strong where I'm weak" swap.
  for (const surplusA of profileA.surpluses) {
    const bNeedsIt = profileB.needs.find((need) => need.pos === surplusA.pos);
    if (!bNeedsIt) {
      continue;
    }

    for (const surplusB of profileB.surpluses) {
      if (surplusB.pos === surplusA.pos) {
        continue;
      }
      const aNeedsIt = profileA.needs.find((need) => need.pos === surplusB.pos);
      if (!aNeedsIt) {
        continue;
      }

      const idea = buildFairSwap({
        a,
        b,
        posFromA: surplusA.pos,
        posFromB: surplusB.pos,
        needReliefScore:
          surplusA.gap + surplusB.gap + aNeedsIt.gap + bNeedsIt.gap,
        ...opts,
      });
      if (idea) {
        ideas.push(idea);
      }
    }
  }

  return ideas;
}

// Finds the best fair package swap between A (giving at posFromA) and B (giving
// at posFromB). Tries 1-for-1 first, then a bounded 2-for-2 which can balance
// value better when the top pieces are lopsided. Each team keeps its single
// best asset at its surplus position (the piece that *makes* it a surplus) and
// offers from the tier below, when it has the depth to.
function buildFairSwap({
  a,
  b,
  posFromA,
  posFromB,
  needReliefScore,
  fairnessBand,
  minAssetValue,
}) {
  const poolA = offerPool(a, posFromA, minAssetValue);
  const poolB = offerPool(b, posFromB, minAssetValue);
  if (poolA.length === 0 || poolB.length === 0) {
    return null;
  }

  let best = null;
  const consider = (sendFromA, sendFromB) => {
    const scored = scoreSwap(sendFromA, sendFromB, needReliefScore, fairnessBand);
    if (scored && (!best || scored.score > best.score)) {
      best = { ...scored, sendFromA, sendFromB, posFromA, posFromB };
    }
  };

  for (const playerA of poolA) {
    for (const playerB of poolB) {
      consider([playerA], [playerB]);
    }
  }

  // Bounded 2-for-2 (top 4 offers per side keeps this ~36 combos at most).
  if (poolA.length >= 2 && poolB.length >= 2) {
    const capA = poolA.slice(0, 4);
    const capB = poolB.slice(0, 4);
    for (let x = 0; x < capA.length; x += 1) {
      for (let x2 = x + 1; x2 < capA.length; x2 += 1) {
        for (let y = 0; y < capB.length; y += 1) {
          for (let y2 = y + 1; y2 < capB.length; y2 += 1) {
            consider([capA[x], capA[x2]], [capB[y], capB[y2]]);
          }
        }
      }
    }
  }

  return best ? { teamA: a, teamB: b, ...best } : null;
}

// A team's tradeable pieces at a position: value-sorted, keystone (the top
// asset) held back when there's depth behind it, floored at minAssetValue.
function offerPool(team, position, minAssetValue) {
  const atPosition = team.players
    .filter((player) => player.position === position && player.value > minAssetValue)
    .sort((left, right) => right.value - left.value);
  if (atPosition.length === 0) {
    return [];
  }

  const belowKeystone = atPosition.slice(1);
  return belowKeystone.length > 0 ? belowKeystone : atPosition;
}

function scoreSwap(sendFromA, sendFromB, needReliefScore, fairnessBand) {
  const sentA = sumValue(sendFromA);
  const sentB = sumValue(sendFromB);
  const baseline = Math.max((sentA + sentB) / 2, 1);
  // A gives sentA, receives sentB; mirror score for B. Fair if within the band.
  const scoreForA = (sentB - sentA) / baseline;
  if (Math.abs(scoreForA) > fairnessBand) {
    return null;
  }

  const combinedValue = sentA + sentB;
  const fairnessBonus = (fairnessBand - Math.abs(scoreForA)) / fairnessBand; // 0..1
  // Rank primarily by need relief, then reward fairer and more impactful deals.
  const score = needReliefScore * (0.5 + 0.5 * fairnessBonus) + combinedValue * 0.05;

  return { scoreForA, sentA, sentB, baseline, combinedValue, score };
}

// A one-line, source-neutral rationale for a trade idea. `valueLabel` lets
// callers name the source (e.g. "KeepTradeCut value"); defaults to "value".
export function describeTradeIdea(idea, { valueLabel = "value" } = {}) {
  const aGives = formatPackage(idea.sendFromA);
  const bGives = formatPackage(idea.sendFromB);
  const deltaForA = Math.round(idea.sentB - idea.sentA);

  let swing;
  if (deltaForA === 0) {
    swing = "dead even";
  } else if (deltaForA > 0) {
    swing = `+${deltaForA.toLocaleString()} ${idea.teamA.label}`;
  } else {
    swing = `+${Math.abs(deltaForA).toLocaleString()} ${idea.teamB.label}`;
  }

  return (
    `${idea.teamA.label} sends ${aGives} for ${bGives} — ` +
    `fills ${idea.teamA.label}'s ${idea.posFromB} & ${idea.teamB.label}'s ${idea.posFromA} ` +
    `(${swing} in ${valueLabel})`
  );
}

function formatPackage(players) {
  return players
    .map((player) => `${player.name} (${player.position}·${Math.round(player.value).toLocaleString()})`)
    .join(" + ");
}

function sumValue(players) {
  return players.reduce((sum, player) => sum + player.value, 0);
}
