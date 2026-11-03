// Load/save for the per-feature JSON state files under .state/ (weekly report,
// power rankings, rivalry, big matchups, playoffs, chat commands, AI mentions,
// draft preview/results, milestones, record book, Hall of Fame), plus the small
// has/mark helpers that read and update those state objects. Moved verbatim
// out of index.js. runtime-state.json (the trade queue) and trade-history.json
// stay in index.js next to the trade poller that owns them.
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import { createEmptyAiMentionState } from "./ai-mention.js";
import { createEmptyHallOfFame } from "./hall-of-fame.js";
import { parseJsonFile } from "./logging.js";
import { createEmptyMilestoneState, createEmptyRecordBook } from "./milestones.js";

export const STATE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), ".state");
const WEEKLY_REPORT_STATE_FILE = path.join(
  STATE_DIR,
  "weekly-report-state.json"
);
const POWER_RANKINGS_STATE_FILE = path.join(
  STATE_DIR,
  "power-rankings-state.json"
);
const DIVISION_RIVALRY_STATE_FILE = path.join(
  STATE_DIR,
  "division-rivalry-state.json"
);
const BIG_MATCHUPS_STATE_FILE = path.join(
  STATE_DIR,
  "big-matchups-state.json"
);
const DRAFT_PREVIEW_STATE_FILE = path.join(
  STATE_DIR,
  "draft-preview-state.json"
);
const DRAFT_RESULTS_STATE_FILE = path.join(
  STATE_DIR,
  "draft-results-state.json"
);
const HALL_OF_FAME_FILE = path.join(STATE_DIR, "hall-of-fame.json");
const CHAT_COMMANDS_STATE_FILE = path.join(STATE_DIR, "chat-commands-state.json");
const AI_MENTION_STATE_FILE = path.join(STATE_DIR, "ai-mention-state.json");
const PLAYOFF_BRACKET_STATE_FILE = path.join(
  STATE_DIR,
  "playoff-bracket-state.json"
);
const PLAYOFF_WEEKLY_STATE_FILE = path.join(
  STATE_DIR,
  "playoff-weekly-state.json"
);
const PLAYOFF_RECAP_STATE_FILE = path.join(
  STATE_DIR,
  "playoff-recap-state.json"
);
const MILESTONE_STATE_FILE = path.join(STATE_DIR, "milestone-state.json");
const RECORD_BOOK_FILE = path.join(STATE_DIR, "record-book.json");

export async function loadWeeklyReportState() {
  await fs.mkdir(STATE_DIR, { recursive: true });

  try {
    const fileContents = await fs.readFile(WEEKLY_REPORT_STATE_FILE, "utf8");
    const parsed = parseJsonFile(fileContents);

    return {
      sentBySeason: parsed?.sentBySeason ?? {},
    };
  } catch (error) {
    return {
      sentBySeason: {},
    };
  }
}

export async function saveWeeklyReportState(state) {
  await fs.mkdir(STATE_DIR, { recursive: true });

  const serialized = {
    updatedAt: new Date().toISOString(),
    sentBySeason: state.sentBySeason ?? {},
  };

  await fs.writeFile(
    WEEKLY_REPORT_STATE_FILE,
    JSON.stringify(serialized, null, 2),
    "utf8"
  );
}

export async function loadDivisionRivalryState() {
  await fs.mkdir(STATE_DIR, { recursive: true });

  try {
    const fileContents = await fs.readFile(DIVISION_RIVALRY_STATE_FILE, "utf8");
    const parsed = parseJsonFile(fileContents);

    return {
      sentBySeason: parsed?.sentBySeason ?? {},
    };
  } catch (error) {
    return {
      sentBySeason: {},
    };
  }
}

export async function saveDivisionRivalryState(state) {
  await fs.mkdir(STATE_DIR, { recursive: true });

  const serialized = {
    updatedAt: new Date().toISOString(),
    sentBySeason: state.sentBySeason ?? {},
  };

  await fs.writeFile(
    DIVISION_RIVALRY_STATE_FILE,
    JSON.stringify(serialized, null, 2),
    "utf8"
  );
}

export async function loadBigMatchupsState() {
  await fs.mkdir(STATE_DIR, { recursive: true });

  try {
    const fileContents = await fs.readFile(BIG_MATCHUPS_STATE_FILE, "utf8");
    const parsed = parseJsonFile(fileContents);

    return {
      sentBySeason: parsed?.sentBySeason ?? {},
    };
  } catch (error) {
    return {
      sentBySeason: {},
    };
  }
}

export async function saveBigMatchupsState(state) {
  await fs.mkdir(STATE_DIR, { recursive: true });

  const serialized = {
    updatedAt: new Date().toISOString(),
    sentBySeason: state.sentBySeason ?? {},
  };

  await fs.writeFile(
    BIG_MATCHUPS_STATE_FILE,
    JSON.stringify(serialized, null, 2),
    "utf8"
  );
}

export async function loadPlayoffBracketState() {
  await fs.mkdir(STATE_DIR, { recursive: true });

  try {
    const fileContents = await fs.readFile(PLAYOFF_BRACKET_STATE_FILE, "utf8");
    const parsed = parseJsonFile(fileContents);

    return {
      sentBySeason: parsed?.sentBySeason ?? {},
      baselinedSeason: parsed?.baselinedSeason ?? null,
    };
  } catch (error) {
    return { sentBySeason: {}, baselinedSeason: null };
  }
}

export async function savePlayoffBracketState(state) {
  await fs.mkdir(STATE_DIR, { recursive: true });

  const serialized = {
    updatedAt: new Date().toISOString(),
    sentBySeason: state.sentBySeason ?? {},
    baselinedSeason: state.baselinedSeason ?? null,
  };

  await fs.writeFile(
    PLAYOFF_BRACKET_STATE_FILE,
    JSON.stringify(serialized, null, 2),
    "utf8"
  );
}

export async function loadPlayoffWeeklyState() {
  await fs.mkdir(STATE_DIR, { recursive: true });

  try {
    const fileContents = await fs.readFile(PLAYOFF_WEEKLY_STATE_FILE, "utf8");
    const parsed = parseJsonFile(fileContents);

    return {
      sentBySeason: parsed?.sentBySeason ?? {},
      baselinedSeason: parsed?.baselinedSeason ?? null,
    };
  } catch (error) {
    return { sentBySeason: {}, baselinedSeason: null };
  }
}

export async function savePlayoffWeeklyState(state) {
  await fs.mkdir(STATE_DIR, { recursive: true });

  const serialized = {
    updatedAt: new Date().toISOString(),
    sentBySeason: state.sentBySeason ?? {},
    baselinedSeason: state.baselinedSeason ?? null,
  };

  await fs.writeFile(
    PLAYOFF_WEEKLY_STATE_FILE,
    JSON.stringify(serialized, null, 2),
    "utf8"
  );
}

export async function loadPlayoffRecapState() {
  await fs.mkdir(STATE_DIR, { recursive: true });

  try {
    const fileContents = await fs.readFile(PLAYOFF_RECAP_STATE_FILE, "utf8");
    const parsed = parseJsonFile(fileContents);

    return {
      sentBySeason: parsed?.sentBySeason ?? {},
    };
  } catch (error) {
    return { sentBySeason: {} };
  }
}

export async function savePlayoffRecapState(state) {
  await fs.mkdir(STATE_DIR, { recursive: true });

  const serialized = {
    updatedAt: new Date().toISOString(),
    sentBySeason: state.sentBySeason ?? {},
  };

  await fs.writeFile(
    PLAYOFF_RECAP_STATE_FILE,
    JSON.stringify(serialized, null, 2),
    "utf8"
  );
}

export async function loadChatCommandsState() {
  await fs.mkdir(STATE_DIR, { recursive: true });

  try {
    const fileContents = await fs.readFile(CHAT_COMMANDS_STATE_FILE, "utf8");
    const parsed = parseJsonFile(fileContents);

    return {
      primed: Boolean(parsed?.primed),
      handledSignatures: Array.isArray(parsed?.handledSignatures)
        ? parsed.handledSignatures
        : [],
    };
  } catch (error) {
    return {
      primed: false,
      handledSignatures: [],
    };
  }
}

export async function saveChatCommandsState(state) {
  await fs.mkdir(STATE_DIR, { recursive: true });

  const serialized = {
    updatedAt: new Date().toISOString(),
    primed: Boolean(state.primed),
    // Keep only the most recent signatures -- old ephemeral messages are gone
    // from Snapchat, so their dedupe entries are dead weight.
    handledSignatures: (state.handledSignatures ?? []).slice(-200),
  };

  await fs.writeFile(
    CHAT_COMMANDS_STATE_FILE,
    JSON.stringify(serialized, null, 2),
    "utf8"
  );
}

export async function loadAiMentionState() {
  await fs.mkdir(STATE_DIR, { recursive: true });

  try {
    const fileContents = await fs.readFile(AI_MENTION_STATE_FILE, "utf8");
    const parsed = parseJsonFile(fileContents);
    return {
      ...createEmptyAiMentionState(),
      ...parsed,
      primed: Boolean(parsed?.primed),
      lastAskBySender: parsed?.lastAskBySender ?? {},
      bareTagFirstSeen: parsed?.bareTagFirstSeen ?? {},
    };
  } catch (error) {
    return { ...createEmptyAiMentionState(), primed: false };
  }
}

export async function saveAiMentionState(state) {
  await fs.mkdir(STATE_DIR, { recursive: true });

  const { updatedAt, ...rest } = state;
  await fs.writeFile(
    AI_MENTION_STATE_FILE,
    JSON.stringify({ updatedAt: new Date().toISOString(), ...rest }, null, 2),
    "utf8"
  );
}

export async function loadDraftPreviewState() {
  await fs.mkdir(STATE_DIR, { recursive: true });

  try {
    const fileContents = await fs.readFile(DRAFT_PREVIEW_STATE_FILE, "utf8");
    const parsed = parseJsonFile(fileContents);

    return {
      sentByDraftId: parsed?.sentByDraftId ?? {},
    };
  } catch (error) {
    return {
      sentByDraftId: {},
    };
  }
}

export async function saveDraftPreviewState(state) {
  await fs.mkdir(STATE_DIR, { recursive: true });

  const serialized = {
    updatedAt: new Date().toISOString(),
    sentByDraftId: state.sentByDraftId ?? {},
  };

  await fs.writeFile(
    DRAFT_PREVIEW_STATE_FILE,
    JSON.stringify(serialized, null, 2),
    "utf8"
  );
}

export function hasSentDraftPreview(state, draftId) {
  return Boolean(state?.sentByDraftId?.[draftId]);
}

export function markDraftPreviewSent(state, { draftId, leagueId }) {
  if (!state.sentByDraftId) {
    state.sentByDraftId = {};
  }

  state.sentByDraftId[draftId] = {
    sentAt: new Date().toISOString(),
    leagueId,
  };
}

export async function loadDraftResultsState() {
  await fs.mkdir(STATE_DIR, { recursive: true });

  try {
    const fileContents = await fs.readFile(DRAFT_RESULTS_STATE_FILE, "utf8");
    const parsed = parseJsonFile(fileContents);

    return {
      snapshotsByDraftId: parsed?.snapshotsByDraftId ?? {},
    };
  } catch (error) {
    return {
      snapshotsByDraftId: {},
    };
  }
}

export async function saveDraftResultsState(state) {
  await fs.mkdir(STATE_DIR, { recursive: true });

  const serialized = {
    updatedAt: new Date().toISOString(),
    snapshotsByDraftId: state.snapshotsByDraftId ?? {},
  };

  await fs.writeFile(
    DRAFT_RESULTS_STATE_FILE,
    JSON.stringify(serialized, null, 2),
    "utf8"
  );
}

export function hasDraftResultsSnapshot(state, draftId) {
  return Boolean(state?.snapshotsByDraftId?.[draftId]);
}

export function markDraftResultsSnapshot(state, draftId, snapshot) {
  if (!state.snapshotsByDraftId) {
    state.snapshotsByDraftId = {};
  }

  state.snapshotsByDraftId[draftId] = snapshot;
}

export function findDraftResultsSnapshotForSeason(draftResultsState, season) {
  const snapshots = Object.values(draftResultsState?.snapshotsByDraftId ?? {});
  return (
    snapshots.find((snapshot) => String(snapshot?.season ?? "") === String(season)) ??
    null
  );
}

export async function loadPowerRankingsState() {
  await fs.mkdir(STATE_DIR, { recursive: true });

  try {
    const fileContents = await fs.readFile(POWER_RANKINGS_STATE_FILE, "utf8");
    const parsed = parseJsonFile(fileContents);

    return {
      sentBySeason: parsed?.sentBySeason ?? {},
      lastRanking: parsed?.lastRanking ?? null,
    };
  } catch (error) {
    return {
      sentBySeason: {},
      lastRanking: null,
    };
  }
}

export async function savePowerRankingsState(state) {
  await fs.mkdir(STATE_DIR, { recursive: true });

  const serialized = {
    updatedAt: new Date().toISOString(),
    sentBySeason: state.sentBySeason ?? {},
    lastRanking: state.lastRanking ?? null,
  };

  await fs.writeFile(
    POWER_RANKINGS_STATE_FILE,
    JSON.stringify(serialized, null, 2),
    "utf8"
  );
}

export async function loadMilestoneState() {
  await fs.mkdir(STATE_DIR, { recursive: true });

  try {
    const fileContents = await fs.readFile(MILESTONE_STATE_FILE, "utf8");
    const parsed = parseJsonFile(fileContents);
    const base = createEmptyMilestoneState();

    return {
      season: parsed?.season ?? null,
      detectedThroughWeek: Number(parsed?.detectedThroughWeek) || 0,
      clinched: Array.isArray(parsed?.clinched) ? parsed.clinched.map(String) : [],
      byeClinched: Array.isArray(parsed?.byeClinched)
        ? parsed.byeClinched.map(String)
        : [],
      eliminated: Array.isArray(parsed?.eliminated)
        ? parsed.eliminated.map(String)
        : [],
      queue: Array.isArray(parsed?.queue) ? parsed.queue : base.queue,
    };
  } catch (error) {
    return createEmptyMilestoneState();
  }
}

export async function saveMilestoneState(state) {
  await fs.mkdir(STATE_DIR, { recursive: true });

  const serialized = {
    updatedAt: new Date().toISOString(),
    season: state.season ?? null,
    detectedThroughWeek: Number(state.detectedThroughWeek) || 0,
    clinched: state.clinched ?? [],
    byeClinched: state.byeClinched ?? [],
    eliminated: state.eliminated ?? [],
    queue: state.queue ?? [],
  };

  await fs.writeFile(
    MILESTONE_STATE_FILE,
    JSON.stringify(serialized, null, 2),
    "utf8"
  );
}

export async function loadRecordBook() {
  await fs.mkdir(STATE_DIR, { recursive: true });

  try {
    const fileContents = await fs.readFile(RECORD_BOOK_FILE, "utf8");
    const parsed = parseJsonFile(fileContents);
    return { ...createEmptyRecordBook(), ...parsed };
  } catch (error) {
    return createEmptyRecordBook();
  }
}

export async function saveRecordBook(book) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(RECORD_BOOK_FILE, JSON.stringify(book, null, 2), "utf8");
}

export async function loadHallOfFameState() {
  await fs.mkdir(STATE_DIR, { recursive: true });

  try {
    const fileContents = await fs.readFile(HALL_OF_FAME_FILE, "utf8");
    const parsed = parseJsonFile(fileContents);
    return { ...createEmptyHallOfFame(), ...parsed };
  } catch (error) {
    return createEmptyHallOfFame();
  }
}

export async function saveHallOfFameState(hallOfFame) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(HALL_OF_FAME_FILE, JSON.stringify(hallOfFame, null, 2), "utf8");
}

export function hasSentWeeklyReport(state, season, week) {
  return Boolean(state?.sentBySeason?.[season]?.[String(week)]);
}

export function markWeeklyReportSent(state, { season, week, leagueId }) {
  if (!state.sentBySeason) {
    state.sentBySeason = {};
  }

  if (!state.sentBySeason[season]) {
    state.sentBySeason[season] = {};
  }

  state.sentBySeason[season][String(week)] = {
    sentAt: new Date().toISOString(),
    leagueId,
  };
}
