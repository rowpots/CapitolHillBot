import {
  buildRosterLookup,
  buildUserLookup,
  formatRosterLabel,
  groupWeekEntriesByMatchup,
  normalizeWeekEntries,
} from "./weekly-report.js";

const EASTERN_TIME_ZONE = "America/New_York";

// Daytime ET slots used to spread milestone messages out across the days
// between detection (Tuesday) and the Thursday cutoff (before the 7 PM power
// rankings and Thursday Night Football).
const SLOT_HOURS_ET = [12, 15, 18];
const MIN_LEAD_MS = 30 * 60 * 1000;

const CLINCH_THRESHOLD = 0.9999;
const ELIMINATION_THRESHOLD = 0.0001;
// Don't call clinch/elimination too early — a 0%/100% Monte Carlo read in the
// first half of the season isn't a real lock, just a confident projection.
const PLAYOFF_ALERT_MIN_WEEK = 8;
// Ignore trivially short "record" win streaks.
const MIN_STREAK_RECORD = 4;

export function createEmptyRecordBook() {
  return {
    seededFromHistory: false,
    seededAt: null,
    highestScore: null,
    lowestScore: null,
    biggestBlowout: null,
    longestWinStreak: null,
  };
}

export function createEmptyMilestoneState() {
  return {
    season: null,
    detectedThroughWeek: 0,
    clinched: [],
    byeClinched: [],
    eliminated: [],
    queue: [],
  };
}

// Seeds an all-time record book by walking the league's previous_league_id
// chain. Silent — it only establishes baselines, never produces events.
export async function buildRecordBookFromHistory({
  league,
  fetchJson,
  regularSeasonEndWeek,
  currentThroughWeek,
  logger = console,
}) {
  const book = createEmptyRecordBook();
  const leagues = [];
  let current = league;
  let guard = 0;

  while (current && guard < 25) {
    leagues.push(current);
    const previousId = String(current.previous_league_id ?? "").trim();
    if (!previousId || previousId === "0") {
      break;
    }

    try {
      current = await fetchJson(`https://api.sleeper.app/v1/league/${previousId}`);
    } catch (error) {
      logger.warn?.(`Record seed: could not fetch previous league ${previousId}.`);
      break;
    }
    guard += 1;
  }

  let seededAny = false;
  for (const seasonLeague of leagues) {
    const isCurrent =
      String(seasonLeague.league_id) === String(league.league_id);
    const through = isCurrent ? currentThroughWeek : regularSeasonEndWeek;
    if (through < 1) {
      continue;
    }

    try {
      const [rosters, users] = await Promise.all([
        fetchJson(
          `https://api.sleeper.app/v1/league/${seasonLeague.league_id}/rosters`
        ),
        fetchJson(
          `https://api.sleeper.app/v1/league/${seasonLeague.league_id}/users`
        ),
      ]);
      const matchupsByWeek = await fetchSeasonMatchups(
        seasonLeague.league_id,
        through,
        fetchJson
      );

      mergeSeasonRecords(book, {
        season: String(seasonLeague.season ?? "").trim(),
        rosters,
        users,
        matchupsByWeek,
        throughWeek: through,
      });
      seededAny = true;
    } catch (error) {
      logger.warn?.(
        `Record seed: skipped season ${seasonLeague.season ?? "?"} (${error.message}).`
      );
    }
  }

  // Seeded from history only when we got at least one *prior* season too; if
  // only the current season seeded, leave the flag false so it retries later.
  book.seededFromHistory = seededAny && leagues.length > 1;
  book.seededAt = new Date().toISOString();
  return book;
}

// Pure detection: compares the latest completed week(s) against the seeded
// record book and the standings' playoff odds, returns events plus the updated
// state/book. Assigns spread-out release times. Never sends anything.
export function detectMilestones({
  report,
  matchupsByWeek,
  rosters,
  users,
  latestCompletedWeek,
  season,
  nowMs,
  milestoneState,
  recordBook,
  playoffAlertsEnabled,
  recordBookEnabled,
}) {
  const rosterLookup = buildRosterLookup(rosters);
  const userLookup = buildUserLookup(users);
  const labelFor = (rosterId) =>
    formatRosterLabel(rosterId, rosterLookup, userLookup);

  const state = normalizeMilestoneState(milestoneState, season);
  const book = recordBook ?? createEmptyRecordBook();
  const events = [];

  if (
    playoffAlertsEnabled &&
    latestCompletedWeek >= PLAYOFF_ALERT_MIN_WEEK &&
    Array.isArray(report?.standings)
  ) {
    const newClinches = [];
    const newByeClinches = [];
    const newEliminations = [];

    for (const team of report.standings) {
      const id = String(team.rosterId);
      if (team.playoffOdds >= CLINCH_THRESHOLD && !state.clinched.includes(id)) {
        state.clinched.push(id);
        newClinches.push(team.label);
      }
      if (
        (team.byeOdds ?? 0) >= CLINCH_THRESHOLD &&
        !state.byeClinched.includes(id)
      ) {
        state.byeClinched.push(id);
        newByeClinches.push(team.label);
      }
      if (
        team.playoffOdds <= ELIMINATION_THRESHOLD &&
        !state.eliminated.includes(id)
      ) {
        state.eliminated.push(id);
        newEliminations.push(team.label);
      }
    }

    // Multiple teams can cross the same threshold in the same week (e.g. a
    // tiebreaker resolves several playoff spots at once) — group those into
    // one message per type instead of one per team.
    if (newClinches.length > 0) {
      events.push(makeGroupEvent("clinch", newClinches, { season, week: latestCompletedWeek }));
    }
    if (newByeClinches.length > 0) {
      events.push(
        makeGroupEvent("byeClinch", newByeClinches, { season, week: latestCompletedWeek })
      );
    }
    if (newEliminations.length > 0) {
      events.push(
        makeGroupEvent("eliminated", newEliminations, { season, week: latestCompletedWeek })
      );
    }
  }

  if (recordBookEnabled && book.seededFromHistory) {
    // Scan every week newly completed since we last looked (usually just one).
    // Evaluate ONE candidate per record per week — the week's best — so a record
    // can't fire repeatedly as it ratchets within a single week.
    for (
      let week = state.detectedThroughWeek + 1;
      week <= latestCompletedWeek;
      week += 1
    ) {
      const scores = realWeekScores(matchupsByWeek, week);
      if (scores.length > 0) {
        const high = scores.reduce((best, e) => (e.points > best.points ? e : best));
        const low = scores.reduce((best, e) => (e.points < best.points ? e : best));
        if (isNewHigh(book.highestScore, high.points)) {
          events.push(
            recordEvent("highestScore", book, {
              value: high.points,
              label: labelFor(high.rosterId),
              season,
              week,
            })
          );
        }
        if (isNewLow(book.lowestScore, low.points)) {
          events.push(
            recordEvent("lowestScore", book, {
              value: low.points,
              label: labelFor(low.rosterId),
              season,
              week,
            })
          );
        }
      }

      const matchups = realWeekMatchups(matchupsByWeek, week);
      if (matchups.length > 0) {
        const big = matchups.reduce((best, m) => (m.margin > best.margin ? m : best));
        if (isNewHigh(book.biggestBlowout, big.margin, "margin")) {
          events.push(
            blowoutEvent(book, {
              margin: big.margin,
              winnerLabel: labelFor(big.winnerRosterId),
              loserLabel: labelFor(big.loserRosterId),
              season,
              week,
            })
          );
        }
      }
    }

    // Win streaks are cumulative, so evaluate the whole season once.
    const streak = longestWinStreakForSeason(
      matchupsByWeek,
      latestCompletedWeek,
      labelFor
    );
    if (
      streak &&
      streak.length >= MIN_STREAK_RECORD &&
      (!book.longestWinStreak || streak.length > book.longestWinStreak.length)
    ) {
      events.push(
        streakEvent(book, { length: streak.length, label: streak.label, season })
      );
    }
  }

  // Stamp release times spread across daytime slots Tue -> Thu.
  const slots = computeReleaseSlots({ fromMs: nowMs, count: events.length });
  events.forEach((event, index) => {
    event.releaseAtTimestampMs = slots[index];
    event.queuedAt = new Date(nowMs).toISOString();
    state.queue.push(event);
  });

  state.detectedThroughWeek = Math.max(
    state.detectedThroughWeek,
    latestCompletedWeek
  );

  return { events, milestoneState: state, recordBook: book };
}

export function computeReleaseSlots({ fromMs, count }) {
  if (count <= 0) {
    return [];
  }

  // Generate daytime ET slots forward from now. Typical weeks (a handful of
  // events) fill the next few slots and land Tue->Thu; if there are ever more
  // events than that, they spill into later daytime slots — never overnight.
  const slots = [];
  for (let dayOffset = 0; dayOffset <= 10 && slots.length < count; dayOffset += 1) {
    const parts = getEasternDateParts(new Date(fromMs + dayOffset * 86400000));
    for (const hour of SLOT_HOURS_ET) {
      const slotMs = getEasternTimestampForLocalDateTime({
        year: parts.year,
        month: parts.month,
        day: parts.day,
        hour,
      });
      if (slotMs > fromMs + MIN_LEAD_MS) {
        slots.push(slotMs);
      }
    }
  }
  slots.sort((left, right) => left - right);
  return slots.slice(0, count);
}

export function formatMilestoneMessage(event) {
  return event?.message ?? "";
}

// --- internal helpers -------------------------------------------------------

function normalizeMilestoneState(milestoneState, season) {
  const base = milestoneState ?? createEmptyMilestoneState();
  if (base.season !== season) {
    // New season: clinch/elimination context resets, queue carries over.
    return {
      season,
      detectedThroughWeek: 0,
      clinched: [],
      byeClinched: [],
      eliminated: [],
      queue: Array.isArray(base.queue) ? base.queue : [],
    };
  }

  return {
    season,
    detectedThroughWeek: Number(base.detectedThroughWeek) || 0,
    clinched: Array.isArray(base.clinched) ? base.clinched.map(String) : [],
    byeClinched: Array.isArray(base.byeClinched)
      ? base.byeClinched.map(String)
      : [],
    eliminated: Array.isArray(base.eliminated)
      ? base.eliminated.map(String)
      : [],
    queue: Array.isArray(base.queue) ? base.queue : [],
  };
}

function joinLabels(labels) {
  if (labels.length === 1) {
    return labels[0];
  }
  if (labels.length === 2) {
    return `${labels[0]} and ${labels[1]}`;
  }
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

function makeGroupEvent(type, labels, { season, week }) {
  const verb = labels.length > 1 ? "have" : "has";
  const joined = joinLabels(labels);
  const message =
    type === "clinch"
      ? `🎉 ${joined} ${verb} clinched a playoff spot!`
      : type === "byeClinch"
      ? `🛌 ${joined} ${verb} clinched a first-round bye!`
      : `❌ ${joined} ${verb} been eliminated from playoff contention.`;

  return {
    id: `${type}-${season}-${week}`,
    type,
    message,
    releaseAtTimestampMs: null,
    queuedAt: null,
  };
}

function recordEvent(kind, book, next) {
  const previous = book[kind];
  const headline = kind === "lowestScore" ? "💩 NEW (DUBIOUS) RECORD" : "🏆 NEW LEAGUE RECORD";
  const title = kind === "lowestScore" ? "Lowest score ever" : "Highest score ever";
  const prevLine = previous
    ? `Previous: ${formatPoints(previous.value)} (${previous.label}, ${previous.season} Wk ${previous.week})`
    : "(first on record)";

  const message = `${headline}\n${title} — ${next.label}: ${formatPoints(
    next.value
  )}\n${prevLine}`;

  book[kind] = {
    value: next.value,
    label: next.label,
    season: next.season,
    week: next.week,
  };

  return {
    id: `record-${kind}-${next.season}-${next.week}`,
    type: "record",
    message,
    releaseAtTimestampMs: null,
    queuedAt: null,
  };
}

function blowoutEvent(book, next) {
  const previous = book.biggestBlowout;
  const prevLine = previous
    ? `Previous: ${formatPoints(previous.margin)} (${previous.winnerLabel}, ${previous.season} Wk ${previous.week})`
    : "(first on record)";

  const message = `🏆 NEW LEAGUE RECORD\nBiggest blowout ever — ${next.winnerLabel} def. ${next.loserLabel} by ${formatPoints(
    next.margin
  )}\n${prevLine}`;

  book.biggestBlowout = { ...next };

  return {
    id: `record-blowout-${next.season}-${next.week}`,
    type: "record",
    message,
    releaseAtTimestampMs: null,
    queuedAt: null,
  };
}

function streakEvent(book, next) {
  const previous = book.longestWinStreak;
  const prevLine = previous
    ? `Previous: ${previous.length} (${previous.label}, ${previous.season})`
    : "(first on record)";

  const message = `🔥 NEW LEAGUE RECORD\nLongest win streak ever — ${next.label}: ${next.length} straight\n${prevLine}`;

  book.longestWinStreak = { ...next };

  return {
    id: `record-streak-${next.season}-${next.length}`,
    type: "record",
    message,
    releaseAtTimestampMs: null,
    queuedAt: null,
  };
}

function isNewHigh(record, value, field = "value") {
  return !record || value > record[field] + 1e-6;
}

function isNewLow(record, value) {
  return !record || value < record.value - 1e-6;
}

function mergeSeasonRecords(book, { season, rosters, users, matchupsByWeek, throughWeek }) {
  const rosterLookup = buildRosterLookup(rosters);
  const userLookup = buildUserLookup(users);
  const labelFor = (rosterId) =>
    formatRosterLabel(rosterId, rosterLookup, userLookup);

  for (let week = 1; week <= throughWeek; week += 1) {
    for (const entry of realWeekScores(matchupsByWeek, week)) {
      if (isNewHigh(book.highestScore, entry.points)) {
        book.highestScore = {
          value: entry.points,
          label: labelFor(entry.rosterId),
          season,
          week,
        };
      }
      if (isNewLow(book.lowestScore, entry.points)) {
        book.lowestScore = {
          value: entry.points,
          label: labelFor(entry.rosterId),
          season,
          week,
        };
      }
    }

    for (const matchup of realWeekMatchups(matchupsByWeek, week)) {
      if (isNewHigh(book.biggestBlowout, matchup.margin, "margin")) {
        book.biggestBlowout = {
          margin: matchup.margin,
          winnerLabel: labelFor(matchup.winnerRosterId),
          loserLabel: labelFor(matchup.loserRosterId),
          season,
          week,
        };
      }
    }
  }

  const streak = longestWinStreakForSeason(matchupsByWeek, throughWeek, labelFor);
  if (streak && (!book.longestWinStreak || streak.length > book.longestWinStreak.length)) {
    book.longestWinStreak = { length: streak.length, label: streak.label, season };
  }
}

export function realWeekScores(matchupsByWeek, week) {
  return normalizeWeekEntries(matchupsByWeek?.[week] ?? []).filter(
    (entry) => entry.points > 0 && entry.matchupId > 0
  );
}

export function realWeekMatchups(matchupsByWeek, week) {
  const grouped = groupWeekEntriesByMatchup(realWeekScores(matchupsByWeek, week));
  const matchups = [];

  for (const pair of grouped.values()) {
    if (pair.length !== 2) {
      continue;
    }
    const [left, right] = pair;
    const winner = left.points >= right.points ? left : right;
    const loser = winner === left ? right : left;
    matchups.push({
      margin: Math.abs(left.points - right.points),
      winnerRosterId: winner.rosterId,
      loserRosterId: loser.rosterId,
    });
  }

  return matchups;
}

export function longestWinStreakForSeason(matchupsByWeek, throughWeek, labelFor) {
  const sequences = new Map();

  for (let week = 1; week <= throughWeek; week += 1) {
    const grouped = groupWeekEntriesByMatchup(realWeekScores(matchupsByWeek, week));
    for (const pair of grouped.values()) {
      if (pair.length !== 2) {
        continue;
      }
      const [left, right] = pair;
      if (Math.abs(left.points - right.points) < 1e-4) {
        pushResult(sequences, left.rosterId, "T");
        pushResult(sequences, right.rosterId, "T");
      } else if (left.points > right.points) {
        pushResult(sequences, left.rosterId, "W");
        pushResult(sequences, right.rosterId, "L");
      } else {
        pushResult(sequences, right.rosterId, "W");
        pushResult(sequences, left.rosterId, "L");
      }
    }
  }

  let best = { length: 0, rosterId: null };
  for (const [rosterId, results] of sequences.entries()) {
    let run = 0;
    let maxRun = 0;
    for (const result of results) {
      if (result === "W") {
        run += 1;
        maxRun = Math.max(maxRun, run);
      } else {
        run = 0;
      }
    }
    if (maxRun > best.length) {
      best = { length: maxRun, rosterId };
    }
  }

  return best.length > 0
    ? { length: best.length, label: labelFor(best.rosterId) }
    : null;
}

function pushResult(sequences, rosterId, result) {
  if (!sequences.has(rosterId)) {
    sequences.set(rosterId, []);
  }
  sequences.get(rosterId).push(result);
}

async function fetchSeasonMatchups(leagueId, throughWeek, fetchJson) {
  const weeks = Array.from({ length: throughWeek }, (_, index) => index + 1);
  const results = await Promise.all(
    weeks.map(async (week) => {
      try {
        const matchups = await fetchJson(
          `https://api.sleeper.app/v1/league/${leagueId}/matchups/${week}`
        );
        return [week, Array.isArray(matchups) ? matchups : []];
      } catch (error) {
        return [week, []];
      }
    })
  );
  return Object.fromEntries(results);
}

function formatPoints(value) {
  return (Number(value) || 0).toFixed(1);
}

// --- Eastern-time helpers (self-contained; mirror index.js) -----------------

function getEasternDateParts(date) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: EASTERN_TIME_ZONE,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const getPart = (type) => parts.find((part) => part.type === type)?.value ?? "";

  return {
    weekday: getPart("weekday"),
    year: Number(getPart("year")),
    month: Number(getPart("month")),
    day: Number(getPart("day")),
    hour: Number(getPart("hour")),
  };
}

function getEasternTimestampForLocalDateTime({ year, month, day, hour, minute = 0 }) {
  const noonUtcDate = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const offsetMinutes = getTimeZoneOffsetMinutes(noonUtcDate);
  return Date.UTC(year, month - 1, day, hour, minute, 0) - offsetMinutes * 60 * 1000;
}

function getTimeZoneOffsetMinutes(date) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: EASTERN_TIME_ZONE,
    timeZoneName: "shortOffset",
    hour: "2-digit",
  });
  const value =
    formatter.formatToParts(date).find((part) => part.type === "timeZoneName")
      ?.value ?? "GMT";
  const match = value.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/i);
  if (!match) {
    return 0;
  }

  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  return sign * (hours * 60 + minutes);
}
