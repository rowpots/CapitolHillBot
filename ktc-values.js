import fs from "fs/promises";
import path from "path";

import {
  buildPlayerLookupKeys,
  clamp,
  formatOrdinal,
  normalizePickLabel,
  normalizePlayerName,
  normalizeText,
  readAnyCache,
  readFreshCache,
  resolveValueMode,
} from "./value-shared.js";

const KTC_RANKINGS_URL = "https://keeptradecut.com/dynasty-rankings";
const VALUES_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PLAYERS_JSON_ELEMENT_ID = "ktc-players";
const PLAYERS_JSON_OPEN_TAG = new RegExp(
  `<script[^>]*\\bid=["']${PLAYERS_JSON_ELEMENT_ID}["'][^>]*>`,
  "i"
);
const LEGACY_PLAYERS_ARRAY_MARKER = "var playersArray = ";

let inMemoryValueBook = null;

export async function loadKtcValueBook({
  cacheDir,
  preferredMode = "auto",
  league = null,
  logger = console,
}) {
  const valueMode = resolveValueMode(preferredMode, league);

  if (inMemoryValueBook && inMemoryValueBook.valueMode === valueMode) {
    return inMemoryValueBook;
  }

  await fs.mkdir(cacheDir, { recursive: true });

  const cacheFilePath = path.join(cacheDir, "ktc-values.json");
  const envelope = await loadPlayersEnvelope(cacheFilePath, logger);

  if (!Array.isArray(envelope.players) || envelope.players.length === 0) {
    throw new Error("KeepTradeCut values file was empty.");
  }

  inMemoryValueBook = buildValueBook(envelope.players, valueMode, envelope.fetchedAt ?? null);
  return inMemoryValueBook;
}

function buildValueBook(players, valueMode, sourceDate) {
  const valueSetKey = valueMode === "2qb" ? "superflexValues" : "oneQBValues";
  const playerLookup = new Map();
  const playerLookupWithoutTeam = new Map();
  const pickLookup = new Map();

  for (const row of players) {
    const numericValue = row?.[valueSetKey]?.value;
    if (typeof numericValue !== "number" || !Number.isFinite(numericValue)) {
      continue;
    }

    if (row.position === "RDP") {
      const label = String(row.playerName ?? "").trim();
      if (!label) {
        continue;
      }

      pickLookup.set(normalizePickLabel(label), numericValue);
      continue;
    }

    const normalizedName = normalizePlayerName(row.playerName);
    const normalizedPosition = normalizeText(row.position);
    const normalizedTeam = normalizeText(row.team);

    if (!normalizedName || !normalizedPosition) {
      continue;
    }

    playerLookup.set(
      `${normalizedName}|${normalizedPosition}|${normalizedTeam}`,
      numericValue
    );

    const fallbackKey = `${normalizedName}|${normalizedPosition}`;
    if (!playerLookupWithoutTeam.has(fallbackKey)) {
      playerLookupWithoutTeam.set(fallbackKey, numericValue);
    }
  }

  return {
    source: "KeepTradeCut",
    sourceDate,
    valueMode,
    getPlayerValue(player) {
      if (!player) {
        return null;
      }

      const playerKeys = buildPlayerLookupKeys(player);
      for (const key of playerKeys.exactKeys) {
        if (playerLookup.has(key)) {
          return playerLookup.get(key);
        }
      }

      for (const key of playerKeys.fallbackKeys) {
        if (playerLookupWithoutTeam.has(key)) {
          return playerLookupWithoutTeam.get(key);
        }
      }

      return null;
    },
    // KTC publishes Early/Mid/Late tier values for rounds 1-4 of the next three
    // draft classes, plus exact-slot values ("2026 Pick 1.07") for the nearest
    // class only. We deliberately read the tier values even when a slot value
    // exists: Sleeper's traded picks carry a season and round but no slot (draft
    // order isn't settled until the season ends), so the slot below is a
    // midpoint *guess* and looking up an exact value for a guessed slot would
    // only be precise, not accurate. Anything past round 4 has no KTC data and
    // returns null just like an unresolved DynastyProcess lookup (callers
    // already treat null as "unknown value").
    getPickValue({ season, round, totalRosters = 12 }) {
      const numericRound = Number(round);
      if (!Number.isFinite(numericRound) || numericRound > 4) {
        return null;
      }

      const projectedPickSlot = clamp(
        Math.max(1, Math.ceil(Number(totalRosters) / 2)),
        1,
        12
      );
      const tier = pickSlotToTier(projectedPickSlot);
      const label = `${season} ${tier} ${formatOrdinal(numericRound)}`;
      const key = normalizePickLabel(label);

      return pickLookup.has(key) ? pickLookup.get(key) : null;
    },
  };
}

// KTC's own bucket ordering, confirmed against live data: Early > Mid > Late
// within every round (Early = earliest/best draft slot).
function pickSlotToTier(slot) {
  if (slot <= 4) {
    return "Early";
  }
  if (slot <= 8) {
    return "Mid";
  }
  return "Late";
}

async function loadPlayersEnvelope(cacheFilePath, logger) {
  const cachedText = await readFreshCache(cacheFilePath, VALUES_CACHE_TTL_MS);
  if (cachedText) {
    return JSON.parse(cachedText);
  }

  try {
    logger.log("Refreshing KeepTradeCut value cache.");
    const response = await fetch(KTC_RANKINGS_URL, {
      headers: {
        "user-agent": "tradebot-snapchat-bridge/1.0",
        accept: "text/html",
      },
    });

    if (!response.ok) {
      throw new Error(
        `KeepTradeCut rankings download failed with status ${response.status}.`
      );
    }

    const html = await response.text();
    const players = extractPlayersArray(html);
    const envelope = { fetchedAt: new Date().toISOString(), players };
    await fs.writeFile(cacheFilePath, JSON.stringify(envelope), "utf8");
    return envelope;
  } catch (error) {
    const staleText = await readAnyCache(cacheFilePath);
    if (staleText) {
      logger.warn(
        "Falling back to stale KeepTradeCut values cache because refresh failed."
      );
      logger.warn(error.message);
      return JSON.parse(staleText);
    }

    throw error;
  }
}

// The rankings page is server-rendered and ships the whole dataset inline — no
// API, no headless browser needed. Since 2026-09 it lives in a
// `<script type="application/json" id="ktc-players">` element that the page's
// own JS reads back with `JSON.parse(document.getElementById(...).textContent)`;
// before that the `var playersArray = ` statement was the array literal itself,
// which `findLegacyPlayersArray` still accepts. Either way this is a brittle
// read of an undocumented page structure (not a stable public contract like
// DynastyProcess's CSV), so every failure mode gets its own message — and says
// which source it came from — to make future debugging obvious.
function extractPlayersArray(html) {
  const source = findPlayersJsonElement(html) ?? findLegacyPlayersArray(html);
  if (!source) {
    throw new Error(
      `KTC player data not found (no #${PLAYERS_JSON_ELEMENT_ID} element, no inline playersArray literal) — page structure may have changed.`
    );
  }

  try {
    return JSON.parse(source.text);
  } catch (parseError) {
    throw new Error(
      `KTC player JSON from ${source.where} could not be parsed — page structure may have changed.`
    );
  }
}

// Script content is raw text in HTML (no entity decoding) and cannot contain an
// unescaped "</script>", so slicing to the first one yields the exact JSON.
function findPlayersJsonElement(html) {
  const openTag = PLAYERS_JSON_OPEN_TAG.exec(html);
  if (!openTag) {
    return null;
  }

  const contentStart = openTag.index + openTag[0].length;
  const contentEnd = html.indexOf("</script>", contentStart);
  if (contentEnd === -1) {
    return null;
  }

  return {
    where: `the #${PLAYERS_JSON_ELEMENT_ID} element`,
    text: html.slice(contentStart, contentEnd),
  };
}

// The pre-2026-09 layout. The leading-"[" guard is the whole point: once the
// statement became `var playersArray = JSON.parse(...)`, the old unguarded
// slice ran straight past it to the `];` of the *next* variable and handed
// JSON.parse a meaningless fragment — a confusing "could not be parsed" for
// what was really "the data moved".
function findLegacyPlayersArray(html) {
  const markerIndex = html.indexOf(LEGACY_PLAYERS_ARRAY_MARKER);
  if (markerIndex === -1) {
    return null;
  }

  const arrayStart = markerIndex + LEGACY_PLAYERS_ARRAY_MARKER.length;
  if (html[arrayStart] !== "[") {
    return null;
  }

  const arrayEnd = html.indexOf("];", arrayStart);
  if (arrayEnd === -1) {
    return null;
  }

  return {
    where: "the inline playersArray literal",
    text: html.slice(arrayStart, arrayEnd + 1),
  };
}
