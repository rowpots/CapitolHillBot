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

const DYNASTYPROCESS_VALUES_URL =
  "https://raw.githubusercontent.com/dynastyprocess/data/master/files/values.csv";
const VALUES_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

let inMemoryValueBook = null;

// Dispatches to the configured value source. DynastyProcess stays the
// default so existing deployments are unaffected; VALUE_SOURCE=ktc opts a
// league into KeepTradeCut values instead. Both sources implement the same
// { source, sourceDate, valueMode, getPlayerValue, getPickValue } shape, so
// callers never need to know which one is active.
export async function loadValueBook({
  source = "dynastyprocess",
  cacheDir,
  preferredMode,
  league,
  logger,
}) {
  if (String(source ?? "dynastyprocess").toLowerCase() === "ktc") {
    const { loadKtcValueBook } = await import("./ktc-values.js");
    return loadKtcValueBook({ cacheDir, preferredMode, league, logger });
  }

  return loadDynastyValueBook({ cacheDir, preferredMode, league, logger });
}

export async function loadDynastyValueBook({
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

  const cacheFilePath = path.join(cacheDir, "dynastyprocess-values.csv");
  const csvText = await loadValuesCsv(cacheFilePath, logger);
  const rows = parseCsv(csvText);

  if (rows.length === 0) {
    throw new Error("DynastyProcess values file was empty.");
  }

  const valueColumnName = valueMode === "2qb" ? "value_2qb" : "value_1qb";
  const sourceDate = rows[0]?.scrape_date ?? null;
  const playerLookup = new Map();
  const playerLookupWithoutTeam = new Map();
  const pickLookup = new Map();
  const pickRoundAverages = new Map();

  for (const row of rows) {
    const numericValue = parseNullableNumber(row[valueColumnName]);
    if (numericValue == null) {
      continue;
    }

    if (String(row.pos).toUpperCase() === "PICK") {
      const label = String(row.player ?? "").trim();
      if (!label) {
        continue;
      }

      pickLookup.set(normalizePickLabel(label), numericValue);

      const roundAverageMatch = label.match(/^(\d{4}) Pick (\d+)\.(\d{2})$/i);
      if (roundAverageMatch) {
        const [, season, round] = roundAverageMatch;
        const roundAverageKey = `${season}-${round}`;
        const existingEntry = pickRoundAverages.get(roundAverageKey) ?? {
          total: 0,
          count: 0,
        };

        existingEntry.total += numericValue;
        existingEntry.count += 1;
        pickRoundAverages.set(roundAverageKey, existingEntry);
      }

      continue;
    }

    const normalizedName = normalizeText(row.player);
    const normalizedPosition = normalizeText(row.pos);
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

  const roundAverageValueLookup = new Map();
  for (const [roundKey, entry] of pickRoundAverages.entries()) {
    roundAverageValueLookup.set(roundKey, entry.total / entry.count);
  }

  inMemoryValueBook = {
    source: "DynastyProcess",
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
    getPickValue({ season, round, totalRosters = 12 }) {
      const exactGenericLabel = `${season} ${formatOrdinal(round)}`;
      const exactGenericKey = normalizePickLabel(exactGenericLabel);
      if (pickLookup.has(exactGenericKey)) {
        return pickLookup.get(exactGenericKey);
      }

      const roundAverageKey = `${season}-${round}`;
      if (roundAverageValueLookup.has(roundAverageKey)) {
        return roundAverageValueLookup.get(roundAverageKey);
      }

      const projectedPickSlot = clamp(
        Math.max(1, Math.ceil(Number(totalRosters) / 2)),
        1,
        12
      );
      const specificLabel = `${season} Pick ${round}.${String(
        projectedPickSlot
      ).padStart(2, "0")}`;
      const specificKey = normalizePickLabel(specificLabel);
      if (pickLookup.has(specificKey)) {
        return pickLookup.get(specificKey);
      }

      return null;
    },
  };

  return inMemoryValueBook;
}

// Kept as an alias for anything importing the old name directly.
export { resolveValueMode as resolveDynastyValueMode };

async function loadValuesCsv(cacheFilePath, logger) {
  const cachedCsv = await readFreshCache(cacheFilePath, VALUES_CACHE_TTL_MS);
  if (cachedCsv) {
    return cachedCsv;
  }

  try {
    logger.log("Refreshing DynastyProcess value cache.");
    const response = await fetch(DYNASTYPROCESS_VALUES_URL, {
      headers: {
        "user-agent": "tradebot-snapchat-bridge/1.0",
        accept: "text/csv",
      },
    });

    if (!response.ok) {
      throw new Error(
        `DynastyProcess values download failed with status ${response.status}.`
      );
    }

    const csvText = await response.text();
    await fs.writeFile(cacheFilePath, csvText, "utf8");
    return csvText;
  } catch (error) {
    const staleCsv = await readAnyCache(cacheFilePath);
    if (staleCsv) {
      logger.warn(
        "Falling back to stale DynastyProcess values cache because refresh failed."
      );
      logger.warn(error.message);
      return staleCsv;
    }

    throw error;
  }
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const nextCharacter = text[index + 1];

    if (character === '"') {
      if (inQuotes && nextCharacter === '"') {
        field += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (character === "," && !inQuotes) {
      row.push(field);
      field = "";
      continue;
    }

    if ((character === "\n" || character === "\r") && !inQuotes) {
      if (character === "\r" && nextCharacter === "\n") {
        index += 1;
      }

      row.push(field);
      field = "";

      if (row.length > 1 || row[0] !== "") {
        rows.push(row);
      }

      row = [];
      continue;
    }

    field += character;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  if (rows.length === 0) {
    return [];
  }

  const [headerRow, ...dataRows] = rows;
  return dataRows.map((dataRow) => {
    const rowObject = {};

    for (let columnIndex = 0; columnIndex < headerRow.length; columnIndex += 1) {
      rowObject[headerRow[columnIndex]] = dataRow[columnIndex] ?? "";
    }

    return rowObject;
  });
}

function parseNullableNumber(value) {
  if (value == null || value === "" || value === "NA") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
