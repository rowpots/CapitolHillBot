import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROASTS_FILE = path.join(__dirname, "roasts.json");

export const DEFAULT_ROAST_TEMPLATES = {
  mild: [
    "{loser} traded like they built their roster with a blindfold on.",
    "{loser} blinked first and handed {winner} an easy win.",
    "{loser} somehow made a routine deal look embarrassing.",
  ],
  medium: [
    "{loser} just got worked so badly the league should start a relief fund.",
    "{winner} walked away smiling while {loser} donated talent for free.",
    "{loser} negotiated this trade like a complete clown.",
  ],
  severe: [
    "{loser} turned trade talks into a full public humiliation.",
    "{winner} absolutely fleeced {loser}, and nobody is going to let them forget it.",
    "{loser} should mute the group chat because this trade is going to haunt them.",
  ],
};

let lastWarningMessage = "";

export function getRoastForSeverity({
  severity,
  winner,
  loser,
  seed,
  logger = console,
}) {
  const templates = loadRoastTemplates(logger);
  const choices =
    templates[severity] && templates[severity].length > 0
      ? templates[severity]
      : DEFAULT_ROAST_TEMPLATES[severity] ?? DEFAULT_ROAST_TEMPLATES.mild;
  const index = stableHash(String(seed ?? `${winner}:${loser}:${severity}`)) % choices.length;

  return fillTemplate(choices[index], {
    winner,
    loser,
  });
}

export function loadRoastTemplates(logger = console) {
  try {
    const fileContents = fs.readFileSync(ROASTS_FILE, "utf8");
    const parsed = JSON.parse(fileContents);
    clearWarning();
    return normalizeRoastTemplates(parsed);
  } catch (error) {
    const warningMessage =
      error?.code === "ENOENT"
        ? `Roast template file not found at ${ROASTS_FILE}. Using defaults.`
        : `Unable to load roast templates from ${ROASTS_FILE}. Using defaults. ${error.message}`;
    warnOnce(logger, warningMessage);
    return DEFAULT_ROAST_TEMPLATES;
  }
}

function normalizeRoastTemplates(parsed) {
  const normalized = {};

  for (const severity of Object.keys(DEFAULT_ROAST_TEMPLATES)) {
    const candidateLines = Array.isArray(parsed?.[severity]) ? parsed[severity] : [];
    const cleanedLines = candidateLines
      .map((line) => String(line ?? "").trim())
      .filter(Boolean);

    normalized[severity] =
      cleanedLines.length > 0
        ? cleanedLines
        : DEFAULT_ROAST_TEMPLATES[severity];
  }

  return normalized;
}

function fillTemplate(template, values) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => {
    return values[key] ?? `{${key}}`;
  });
}

function stableHash(value) {
  let hash = 0;

  for (const character of String(value)) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }

  return hash;
}

function warnOnce(logger, message) {
  if (message === lastWarningMessage) {
    return;
  }

  lastWarningMessage = message;
  logger.warn(message);
}

function clearWarning() {
  lastWarningMessage = "";
}
