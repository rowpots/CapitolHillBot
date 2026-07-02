import fs from "fs/promises";

// Shared, source-agnostic helpers used by both dynasty-values.js
// (DynastyProcess) and ktc-values.js (KeepTradeCut) value books.

export function resolveValueMode(preferredMode, league = null) {
  const normalizedMode = String(preferredMode ?? "auto").toLowerCase();
  if (normalizedMode === "1qb" || normalizedMode === "2qb") {
    return normalizedMode;
  }

  const rosterPositions = Array.isArray(league?.roster_positions)
    ? league.roster_positions
    : [];

  if (rosterPositions.includes("SUPER_FLEX")) {
    return "2qb";
  }

  const quarterbackSlots = rosterPositions.filter(
    (position) => position === "QB"
  ).length;

  if (quarterbackSlots >= 2) {
    return "2qb";
  }

  return "1qb";
}

export function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export function buildPlayerLookupKeys(player) {
  const normalizedName = normalizeText(
    player.full_name ||
      [player.first_name, player.last_name].filter(Boolean).join(" ")
  );
  const normalizedPosition = normalizeText(player.position);
  const normalizedTeam = normalizeText(player.team);

  return {
    exactKeys: [
      `${normalizedName}|${normalizedPosition}|${normalizedTeam}`,
      `${normalizedName}|${normalizedPosition}|`,
    ],
    fallbackKeys: [`${normalizedName}|${normalizedPosition}`],
  };
}

export function normalizePickLabel(label) {
  return String(label ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function formatOrdinal(round) {
  const numericRound = Number(round);
  if (!Number.isFinite(numericRound)) {
    return `${round}`;
  }

  if (numericRound % 100 >= 11 && numericRound % 100 <= 13) {
    return `${numericRound}th`;
  }

  switch (numericRound % 10) {
    case 1:
      return `${numericRound}st`;
    case 2:
      return `${numericRound}nd`;
    case 3:
      return `${numericRound}rd`;
    default:
      return `${numericRound}th`;
  }
}

export function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

export async function readFreshCache(cacheFilePath, ttlMs) {
  try {
    const stats = await fs.stat(cacheFilePath);
    const cacheAgeMs = Date.now() - stats.mtimeMs;

    if (cacheAgeMs > ttlMs) {
      return null;
    }

    return fs.readFile(cacheFilePath, "utf8");
  } catch (error) {
    return null;
  }
}

export async function readAnyCache(cacheFilePath) {
  try {
    return await fs.readFile(cacheFilePath, "utf8");
  } catch (error) {
    return null;
  }
}
