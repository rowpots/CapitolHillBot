import fs from "fs/promises";
import path from "path";

import {
  buildPlayerLookupKeys,
  clamp,
  formatOrdinal,
  normalizePickLabel,
  normalizeText,
  readAnyCache,
  readFreshCache,
  resolveValueMode,
} from "./value-shared.js";

const KTC_RANKINGS_URL = "https://keeptradecut.com/dynasty-rankings";
const VALUES_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PLAYERS_ARRAY_MARKER = "var playersArray = ";

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

    const normalizedName = normalizeText(row.playerName);
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
    // KTC only publishes generic Early/Mid/Late tier values per round (no
    // exact-slot or round-average data like DynastyProcess), and only for
    // rounds 1-4 — anything beyond that has no KTC data, so it returns null
    // just like an unresolved DynastyProcess lookup (callers already treat
    // null as "unknown value").
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

// The rankings page is server-rendered and embeds the full dataset as a
// plain `var playersArray = [...]` JS statement — no API, no headless
// browser needed. This is a brittle string-slice against an undocumented
// page structure (not a stable public contract like DynastyProcess's CSV),
// so a parse failure is surfaced with a distinct message from a network
// error to make future debugging obvious.
function extractPlayersArray(html) {
  const startIndex = html.indexOf(PLAYERS_ARRAY_MARKER);
  if (startIndex === -1) {
    throw new Error(
      "KTC playersArray marker not found — page structure may have changed."
    );
  }

  const arrayStart = startIndex + PLAYERS_ARRAY_MARKER.length;
  const arrayEnd = html.indexOf("];", arrayStart);
  if (arrayEnd === -1) {
    throw new Error(
      "KTC playersArray closing bracket not found — page structure may have changed."
    );
  }

  const jsonText = html.slice(arrayStart, arrayEnd + 1);

  try {
    return JSON.parse(jsonText);
  } catch (parseError) {
    throw new Error(
      "KTC playersArray JSON could not be parsed — page structure may have changed."
    );
  }
}
