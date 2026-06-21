import fs from "fs/promises";
import path from "path";

import puppeteer from "puppeteer";

const CARD_WIDTH = 1080;
const CARD_HEIGHT = 1920;
const MAX_ASSETS_PER_TEAM_ON_CARD = 8;

export async function renderTradeCardImage({
  analysis,
  stateDir,
  logger = console,
}) {
  const cardsDir = path.join(stateDir, "cards");
  const headshotsDir = path.join(stateDir, "headshots");

  await fs.mkdir(cardsDir, { recursive: true });
  await fs.mkdir(headshotsDir, { recursive: true });

  const outputPath = path.join(cardsDir, `trade-${analysis.tradeId}.png`);
  const visualAnalysis = await hydrateAssetVisuals(analysis, headshotsDir, logger);
  const html = buildTradeCardHtml(visualAnalysis);

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--disable-gpu", "--no-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
      deviceScaleFactor: 1,
    });
    await page.setContent(html, { waitUntil: "load" });
    await page.screenshot({
      path: outputPath,
      type: "png",
      fullPage: false,
    });
  } finally {
    await browser.close();
  }

  return outputPath;
}

async function hydrateAssetVisuals(analysis, headshotsDir, logger) {
  const teams = [];

  for (const team of analysis.teams ?? []) {
    const visualAssets = [];

    for (const asset of team.sentAssets ?? []) {
      visualAssets.push({
        ...asset,
        imageDataUri: await getAssetImageDataUri(asset, headshotsDir, logger),
      });
    }

    teams.push({
      ...team,
      sentAssets: visualAssets,
    });
  }

  return {
    ...analysis,
    teams,
  };
}

async function getAssetImageDataUri(asset, headshotsDir, logger) {
  if (asset.type === "player" && asset.playerId) {
    const cachedHeadshotPath = path.join(headshotsDir, `${asset.playerId}.jpg`);

    try {
      const headshotBytes = await fs.readFile(cachedHeadshotPath);
      return `data:image/jpeg;base64,${headshotBytes.toString("base64")}`;
    } catch (error) {
      try {
        const response = await fetch(
          `https://sleepercdn.com/content/nfl/players/thumb/${asset.playerId}.jpg`,
          {
            headers: {
              "user-agent": "tradebot-snapchat-bridge/1.0",
            },
          }
        );

        if (response.ok) {
          const imageBuffer = Buffer.from(await response.arrayBuffer());
          await fs.writeFile(cachedHeadshotPath, imageBuffer);
          return `data:image/jpeg;base64,${imageBuffer.toString("base64")}`;
        }
      } catch (fetchError) {
        logger.warn(
          `Unable to fetch headshot for player ${asset.playerId}: ${fetchError.message}`
        );
      }
    }
  }

  return buildPlaceholderImageDataUri(asset);
}

function buildTradeCardHtml(analysis) {
  const headerMetaLabel = buildHeaderMetaLabel(analysis);
  const verdictLabel = buildVerdictLabel(analysis);
  const footerNote = buildFooterNote(analysis);
  const panelCount = Math.max(analysis.teams?.length ?? 0, 1);

  const teamPanelsHtml = (analysis.teams ?? [])
    .map((team) => {
      const visibleAssets = (team.sentAssets ?? []).slice(
        0,
        MAX_ASSETS_PER_TEAM_ON_CARD
      );
      const hiddenAssetCount = Math.max(
        0,
        (team.sentAssets?.length ?? 0) - visibleAssets.length
      );

      const assetRowsHtml = visibleAssets
        .map((asset) => {
          return `
            <div class="asset-row">
              <img class="asset-photo" src="${asset.imageDataUri}" alt="${escapeHtml(
            asset.title
          )}">
              <div class="asset-copy">
                <div class="asset-title">${escapeHtml(asset.title)}</div>
                <div class="asset-meta">${escapeHtml(asset.meta)}</div>
              </div>
              <div class="asset-value">${
                asset.value == null ? "&mdash;" : formatValue(asset.value)
              }</div>
            </div>
          `;
        })
        .join("");

      const overflowHtml =
        hiddenAssetCount > 0
          ? `
            <div class="asset-row asset-row--overflow">
              <div class="asset-overflow">+${hiddenAssetCount} more asset${
              hiddenAssetCount === 1 ? "" : "s"
            }</div>
            </div>
          `
          : "";

      return `
        <section class="team-panel ${team.isWinner ? "team-panel--winner" : ""}">
          <div class="team-kicker">${
            team.isWinner ? "Best Value" : "Trade Side"
          }</div>
          <div class="team-header">
            <div class="team-name">${escapeHtml(team.label)}</div>
            <div class="grade-pill grade-pill--${escapeHtml(
              team.gradeFlavor || "neutral"
            )}">${escapeHtml(team.grade || "N/A")}</div>
          </div>
          <div class="team-subtitle">${escapeHtml(
            team.subtitle ||
              `Sent ${formatValue(team.sentValue)} | Received ${formatValue(
                team.receivedValue
              )} | Net ${formatSignedValue(team.netValue)}`
          )}</div>
          <div class="asset-list">
            ${assetRowsHtml}
            ${overflowHtml}
          </div>
        </section>
      `;
    })
    .join("");

  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8">
      <title>Trade Card</title>
      <style>
        :root {
          --paper: #f5efe6;
          --panel: rgba(255, 252, 247, 0.96);
          --panel-strong: #fffdf9;
          --ink: #191816;
          --ink-soft: #635f59;
          --line: #ddd3c6;
          --line-strong: #c9beaf;
          --accent: #7f9273;
          --accent-soft: #aab89f;
          --shadow: rgba(44, 36, 28, 0.08);
          --shadow-strong: rgba(44, 36, 28, 0.14);
          --grade-elite-bg: #eef4e9;
          --grade-elite-text: #506344;
          --grade-good-bg: #f3efe3;
          --grade-good-text: #74674a;
          --grade-neutral-bg: #f1ece5;
          --grade-neutral-text: #6d6256;
          --grade-bad-bg: #f7ebe7;
          --grade-bad-text: #8b5d54;
        }

        * {
          box-sizing: border-box;
        }

        html,
        body {
          margin: 0;
          width: ${CARD_WIDTH}px;
          height: ${CARD_HEIGHT}px;
          overflow: hidden;
          background:
            linear-gradient(180deg, rgba(255, 255, 255, 0.45), rgba(255, 255, 255, 0)) 0 0 / 100% 220px no-repeat,
            linear-gradient(180deg, #f8f4ec 0%, #f1eadf 100%);
          color: var(--ink);
          font-family: "Aptos", "Segoe UI", "Helvetica Neue", Arial, sans-serif;
        }

        body {
          position: relative;
        }

        .page-shell {
          position: relative;
          width: 100%;
          height: 100%;
          padding: 78px 76px 62px;
          display: flex;
          flex-direction: column;
          gap: 28px;
        }

        .page-shell::before {
          content: "";
          position: absolute;
          top: 58px;
          left: 76px;
          width: 132px;
          height: 6px;
          border-radius: 999px;
          background: linear-gradient(90deg, var(--accent), #b7c2ae);
          box-shadow: 0 4px 12px rgba(127, 146, 115, 0.16);
        }

        .header {
          padding-top: 26px;
          text-align: center;
        }

        .eyebrow {
          font-size: 20px;
          font-weight: 700;
          letter-spacing: 0.24em;
          text-transform: uppercase;
          color: var(--ink-soft);
        }

        .headline {
          margin: 18px 0 0;
          font-size: 86px;
          line-height: 0.94;
          letter-spacing: -0.06em;
          font-weight: 800;
        }

        .meta {
          margin-top: 16px;
          font-size: 24px;
          line-height: 1.4;
          color: var(--ink-soft);
        }

        .verdict-chip {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 12px;
          margin-top: 24px;
          padding: 12px 18px;
          border: 1px solid rgba(127, 146, 115, 0.22);
          border-radius: 999px;
          background: rgba(255, 253, 248, 0.84);
          box-shadow: 0 12px 26px var(--shadow);
          color: var(--ink-soft);
          font-size: 21px;
        }

        .verdict-chip__label {
          text-transform: uppercase;
          letter-spacing: 0.16em;
          font-size: 16px;
          font-weight: 700;
          color: var(--accent);
        }

        .verdict-chip__value {
          color: var(--ink);
          font-weight: 700;
        }

        .panels {
          display: grid;
          grid-template-rows: repeat(${panelCount}, minmax(0, 1fr));
          gap: 20px;
          flex: 1;
          min-height: 0;
        }

        .team-panel {
          min-height: 0;
          display: flex;
          flex-direction: column;
          padding: 28px 30px 22px;
          border: 1px solid var(--line);
          border-radius: 30px;
          background: var(--panel);
          box-shadow: 0 18px 42px var(--shadow);
        }

        .team-panel--winner {
          border-color: rgba(127, 146, 115, 0.42);
          box-shadow:
            0 22px 46px var(--shadow-strong),
            inset 0 0 0 1px rgba(127, 146, 115, 0.12);
        }

        .team-kicker {
          font-size: 16px;
          font-weight: 700;
          letter-spacing: 0.16em;
          text-transform: uppercase;
          color: ${analysis.teams?.some((team) => team.isWinner)
            ? "var(--accent)"
            : "var(--ink-soft)"};
        }

        .team-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 18px;
          margin-top: 12px;
        }

        .team-name {
          font-size: 42px;
          line-height: 1.02;
          letter-spacing: -0.04em;
          font-weight: 800;
        }

        .grade-pill {
          flex-shrink: 0;
          min-width: 74px;
          padding: 10px 14px;
          border-radius: 14px;
          font-size: 24px;
          line-height: 1;
          text-align: center;
          font-weight: 800;
          letter-spacing: -0.04em;
          border: 1px solid rgba(0, 0, 0, 0.05);
        }

        .grade-pill--elite {
          background: var(--grade-elite-bg);
          color: var(--grade-elite-text);
        }

        .grade-pill--good {
          background: var(--grade-good-bg);
          color: var(--grade-good-text);
        }

        .grade-pill--neutral {
          background: var(--grade-neutral-bg);
          color: var(--grade-neutral-text);
        }

        .grade-pill--bad {
          background: var(--grade-bad-bg);
          color: var(--grade-bad-text);
        }

        .team-subtitle {
          margin-top: 10px;
          font-size: 22px;
          line-height: 1.35;
          color: var(--ink-soft);
        }

        .asset-list {
          margin-top: 18px;
          display: flex;
          flex-direction: column;
          min-height: 0;
        }

        .asset-row {
          display: grid;
          grid-template-columns: 48px 1fr auto;
          align-items: center;
          gap: 16px;
          min-height: 82px;
          padding: 14px 0;
          border-top: 1px solid rgba(201, 190, 175, 0.56);
        }

        .asset-row:first-child {
          padding-top: 0;
          border-top: none;
        }

        .asset-row--overflow {
          display: flex;
          justify-content: center;
          min-height: auto;
          padding-top: 18px;
        }

        .asset-photo {
          width: 48px;
          height: 60px;
          border-radius: 14px;
          object-fit: cover;
          background: linear-gradient(180deg, #ece5d9, #dfd7ca);
          border: 1px solid rgba(0, 0, 0, 0.06);
        }

        .asset-copy {
          min-width: 0;
        }

        .asset-title {
          font-size: 27px;
          line-height: 1.08;
          letter-spacing: -0.03em;
          font-weight: 700;
        }

        .asset-meta {
          margin-top: 6px;
          font-size: 19px;
          line-height: 1.32;
          color: var(--ink-soft);
        }

        .asset-value {
          padding-left: 12px;
          font-size: 21px;
          line-height: 1;
          font-weight: 700;
          color: var(--accent);
          white-space: nowrap;
        }

        .asset-overflow {
          width: 100%;
          padding-top: 2px;
          border-top: 1px solid rgba(201, 190, 175, 0.56);
          text-align: center;
          font-size: 20px;
          color: var(--ink-soft);
        }

        .footer {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 20px;
          padding-top: 18px;
          border-top: 1px solid rgba(201, 190, 175, 0.64);
          font-size: 20px;
          line-height: 1.35;
          color: var(--ink-soft);
        }

        .footer strong {
          color: var(--ink);
          font-weight: 700;
        }
      </style>
    </head>
    <body>
      <div class="page-shell">
        <header class="header">
          <div class="eyebrow">${escapeHtml(
            analysis.leagueName || "Dynasty League"
          )}</div>
          <h1 class="headline">${escapeHtml(
            analysis.headlineLabel || "TRADE ALERT"
          )}</h1>
          <div class="meta">${escapeHtml(headerMetaLabel)}</div>
          ${
            verdictLabel
              ? `<div class="verdict-chip">
                  <span class="verdict-chip__label">${escapeHtml(
                    analysis.verdictSourceLabel || "Best Value"
                  )}</span>
                  <span class="verdict-chip__value">${escapeHtml(
                    verdictLabel
                  )}</span>
                </div>`
              : ""
          }
        </header>

        <main class="panels">
          ${teamPanelsHtml}
        </main>

        <footer class="footer">
          <div><strong>Trade ID</strong> ${escapeHtml(analysis.tradeId)}</div>
          <div>${escapeHtml(footerNote)}</div>
        </footer>
      </div>
    </body>
  </html>`;
}

function buildHeaderMetaLabel(analysis) {
  const parts = [];

  if (analysis.acceptedAtLabel) {
    parts.push(analysis.acceptedAtLabel);
  }

  if (analysis.valueMetaLabel) {
    parts.push(analysis.valueMetaLabel);
  } else if (analysis.valueSourceLabel) {
    parts.push(
      analysis.valueSourceDateLabel
        ? `${analysis.valueSourceLabel} | Updated ${analysis.valueSourceDateLabel}`
        : analysis.valueSourceLabel
    );
  }

  if (parts.length === 0) {
    return "Sleeper trade card preview";
  }

  return parts.join(" | ");
}

function buildVerdictLabel(analysis) {
  if (analysis.winnerLabel) {
    return analysis.winnerEdgeLabel
      ? `${analysis.winnerLabel} ${analysis.winnerEdgeLabel}`
      : analysis.winnerLabel;
  }

  const winningTeams = (analysis.teams ?? []).filter((team) => team.isWinner);
  if (winningTeams.length !== 1) {
    return "";
  }

  const winner = winningTeams[0];
  if (Number.isFinite(winner.netValue)) {
    return `${winner.label} ${formatSignedValue(winner.netValue)}`;
  }

  return winner.label;
}

function buildFooterNote(analysis) {
  const rivalryTradeNumber = analysis.historyContext?.rivalryTradeNumber;
  const rivalryLabel = analysis.historyContext?.rivalryLabel;

  if (rivalryTradeNumber && rivalryLabel) {
    return `${formatOrdinal(rivalryTradeNumber)} deal between ${rivalryLabel}`;
  }

  return analysis.acceptedAtLabel || "Trade card preview";
}

function buildPlaceholderImageDataUri(asset) {
  const palette = pickPalette(asset);
  const title = asset.type === "faab" ? "$" : asset.type === "pick" ? "P" : "F";
  const subtitle =
    asset.type === "pick"
      ? abbreviatePickLabel(asset.title)
      : asset.type === "faab"
      ? asset.title.replace(" FAAB", "")
      : buildInitials(asset.title);

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="96" height="112" viewBox="0 0 96 112">
      <defs>
        <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stop-color="${palette.start}" />
          <stop offset="100%" stop-color="${palette.end}" />
        </linearGradient>
      </defs>
      <rect width="96" height="112" rx="18" fill="url(#g)" />
      <rect x="8" y="8" width="80" height="96" rx="14" fill="rgba(0,0,0,0.1)" stroke="rgba(255,255,255,0.16)" />
      <text x="48" y="44" text-anchor="middle" font-size="28" font-family="Aptos, Segoe UI, Arial, sans-serif" font-weight="800" fill="#fffaf1">${escapeXml(
        title
      )}</text>
      <text x="48" y="72" text-anchor="middle" font-size="14" font-family="Aptos, Segoe UI, Arial, sans-serif" font-weight="700" fill="rgba(255,250,241,0.92)">${escapeXml(
        subtitle
      )}</text>
    </svg>
  `;

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function pickPalette(asset) {
  if (asset.type === "pick") {
    return { start: "#9ba7c8", end: "#7f8aa8" };
  }

  if (asset.type === "faab") {
    return { start: "#95b592", end: "#6f946b" };
  }

  switch (asset.position) {
    case "QB":
      return { start: "#d8a28b", end: "#b6806b" };
    case "RB":
      return { start: "#8cb0a1", end: "#678f80" };
    case "WR":
      return { start: "#c3ad7f", end: "#9f8a61" };
    case "TE":
      return { start: "#a698bc", end: "#807596" };
    default:
      return { start: "#9b9b98", end: "#757571" };
  }
}

function abbreviatePickLabel(label) {
  const match = String(label).match(/(\d{4}).*?(\d)(?:st|nd|rd|th)/i);
  if (!match) {
    return "PICK";
  }

  return `${match[1]} ${match[2]}R`
    .replace(" 1R", " 1ST")
    .replace(" 2R", " 2ND")
    .replace(" 3R", " 3RD")
    .replace(" 4R", " 4TH");
}

function buildInitials(label) {
  const words = String(label ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);

  if (words.length === 0) {
    return "FF";
  }

  return words.map((word) => word[0]).join("").toUpperCase();
}

function formatValue(value) {
  if (value == null || !Number.isFinite(value)) {
    return "N/A";
  }

  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(Math.round(value));
}

function formatSignedValue(value) {
  if (value == null || !Number.isFinite(value)) {
    return "N/A";
  }

  if (value === 0) {
    return "0";
  }

  return `${value > 0 ? "+" : "-"}${formatValue(Math.abs(value))}`;
}

function formatOrdinal(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return String(value ?? "");
  }

  const mod100 = number % 100;
  if (mod100 >= 11 && mod100 <= 13) {
    return `${number}th`;
  }

  switch (number % 10) {
    case 1:
      return `${number}st`;
    case 2:
      return `${number}nd`;
    case 3:
      return `${number}rd`;
    default:
      return `${number}th`;
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeXml(value) {
  return escapeHtml(value);
}
