import fs from "fs/promises";
import path from "path";

import puppeteer from "puppeteer";

const CARD_WIDTH = 1080;
const CARD_HEIGHT = 1920;
const MAX_ASSETS_PER_TEAM_ON_CARD = 6;

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

  for (const team of analysis.teams) {
    const visualAssets = [];

    for (const asset of team.sentAssets) {
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
  const teamPanelsHtml = analysis.teams
    .map((team) => {
      const visibleAssets = team.sentAssets.slice(0, MAX_ASSETS_PER_TEAM_ON_CARD);
      const hiddenAssetCount = Math.max(
        0,
        team.sentAssets.length - MAX_ASSETS_PER_TEAM_ON_CARD
      );

      const assetRowsHtml = visibleAssets
        .map((asset) => {
          return `
            <div class="asset-row">
              <img class="asset-avatar" src="${asset.imageDataUri}" alt="${escapeHtml(
            asset.title
          )}">
              <div class="asset-copy">
                <div class="asset-title">${escapeHtml(asset.title)}</div>
                <div class="asset-meta">${escapeHtml(asset.meta)}</div>
              </div>
              <div class="asset-value">${
                asset.value == null ? "N/A" : formatValue(asset.value)
              }</div>
            </div>
          `;
        })
        .join("");

      const overflowHtml =
        hiddenAssetCount > 0
          ? `<div class="asset-row asset-row--overflow"><div class="asset-overflow">+${hiddenAssetCount} more asset${
              hiddenAssetCount === 1 ? "" : "s"
            }</div></div>`
          : "";

      return `
        <section class="team-panel ${team.isWinner ? "team-panel--winner" : ""}">
          <div class="team-header">
            <div>
              <div class="team-name">${escapeHtml(team.label)}</div>
              <div class="team-subtitle">${escapeHtml(
                team.subtitle ||
                  `Sent value ${formatValue(team.sentValue)} | Received value ${formatValue(
                    team.receivedValue
                  )}`
              )}</div>
            </div>
            <div class="grade-pill grade-pill--${team.gradeFlavor}">${escapeHtml(
        team.grade
      )}</div>
          </div>
          <div class="team-assets">
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
          --paper: #f6efe3;
          --paper-strong: #fffaf2;
          --panel-border: rgba(255, 255, 255, 0.14);
          --accent-2: #ffd166;
          --muted: rgba(255, 250, 242, 0.7);
        }

        * {
          box-sizing: border-box;
        }

        html, body {
          margin: 0;
          width: ${CARD_WIDTH}px;
          height: ${CARD_HEIGHT}px;
          overflow: hidden;
          font-family: "Trebuchet MS", "Aptos", "Segoe UI", sans-serif;
          color: var(--paper-strong);
          background:
            radial-gradient(circle at top left, rgba(255, 209, 102, 0.35), transparent 28%),
            radial-gradient(circle at top right, rgba(110, 216, 201, 0.22), transparent 24%),
            linear-gradient(165deg, #142530 0%, #0f1720 42%, #2b1f1a 100%);
        }

        body::before {
          content: "";
          position: absolute;
          inset: 0;
          background-image:
            linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px);
          background-size: 54px 54px;
          opacity: 0.55;
        }

        .card-shell {
          position: relative;
          width: 100%;
          height: 100%;
          padding: 52px 42px 42px;
          display: flex;
          flex-direction: column;
          gap: 26px;
        }

        .topbar {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 20px;
        }

        .eyebrow {
          font-size: 24px;
          text-transform: uppercase;
          letter-spacing: 0.24em;
          color: rgba(255, 241, 219, 0.72);
          margin-bottom: 10px;
        }

        .headline {
          margin: 0;
          font-family: Georgia, "Times New Roman", serif;
          font-size: 82px;
          line-height: 0.98;
          letter-spacing: -0.04em;
          max-width: 720px;
        }

        .meta {
          margin-top: 14px;
          font-size: 26px;
          color: var(--muted);
        }

        .winner-chip {
          padding: 16px 18px;
          border-radius: 20px;
          background: linear-gradient(135deg, rgba(255, 141, 99, 0.92), rgba(255, 209, 102, 0.92));
          color: #1d140f;
          min-width: 250px;
          box-shadow: 0 18px 30px rgba(0, 0, 0, 0.16);
        }

        .winner-chip__label {
          text-transform: uppercase;
          letter-spacing: 0.18em;
          font-size: 18px;
          opacity: 0.8;
        }

        .winner-chip__value {
          margin-top: 8px;
          font-size: 30px;
          font-weight: 700;
          line-height: 1.12;
        }

        .panels {
          display: grid;
          grid-template-rows: repeat(${Math.max(analysis.teams.length, 1)}, minmax(0, 1fr));
          gap: 22px;
          flex: 1;
        }

        .team-panel {
          background: linear-gradient(180deg, rgba(8, 18, 25, 0.92), rgba(16, 33, 42, 0.96));
          border: 1px solid var(--panel-border);
          border-radius: 34px;
          padding: 26px 26px 24px;
          box-shadow: 0 18px 36px rgba(0, 0, 0, 0.24);
          display: flex;
          flex-direction: column;
          min-height: 0;
        }

        .team-panel--winner {
          border-color: rgba(183, 241, 113, 0.55);
          box-shadow: 0 22px 38px rgba(0, 0, 0, 0.28), inset 0 0 0 1px rgba(183, 241, 113, 0.18);
        }

        .team-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 20px;
          margin-bottom: 18px;
        }

        .team-name {
          font-size: 42px;
          font-weight: 700;
          line-height: 1.04;
        }

        .team-subtitle {
          margin-top: 8px;
          font-size: 23px;
          color: var(--muted);
        }

        .grade-pill {
          min-width: 100px;
          padding: 12px 16px;
          border-radius: 18px;
          text-align: center;
          font-size: 32px;
          font-weight: 800;
          letter-spacing: -0.03em;
          color: #10161b;
        }

        .grade-pill--elite {
          background: linear-gradient(135deg, #b7f171, #d7ff98);
        }

        .grade-pill--good {
          background: linear-gradient(135deg, #ffd166, #ffe09c);
        }

        .grade-pill--neutral {
          background: linear-gradient(135deg, #ffc179, #ffd6a5);
        }

        .grade-pill--bad {
          background: linear-gradient(135deg, #ff8f86, #ffb0a9);
        }

        .team-assets {
          display: flex;
          flex-direction: column;
          gap: 12px;
          min-height: 0;
        }

        .asset-row {
          display: grid;
          grid-template-columns: 72px 1fr auto;
          align-items: center;
          gap: 16px;
          min-height: 84px;
          padding: 12px 14px;
          border-radius: 22px;
          background: rgba(255, 255, 255, 0.06);
        }

        .asset-row--overflow {
          display: flex;
          justify-content: center;
        }

        .asset-overflow {
          width: 100%;
          text-align: center;
          color: rgba(255, 250, 242, 0.82);
          font-size: 24px;
          letter-spacing: 0.02em;
        }

        .asset-avatar {
          width: 72px;
          height: 72px;
          border-radius: 22px;
          object-fit: cover;
          background: rgba(255,255,255,0.12);
          border: 1px solid rgba(255,255,255,0.1);
        }

        .asset-copy {
          min-width: 0;
        }

        .asset-title {
          font-size: 27px;
          font-weight: 700;
          line-height: 1.08;
        }

        .asset-meta {
          margin-top: 6px;
          font-size: 21px;
          color: rgba(255, 250, 242, 0.68);
        }

        .asset-value {
          margin-left: 12px;
          font-size: 24px;
          font-weight: 700;
          color: var(--accent-2);
        }

        .footer {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 18px;
          font-size: 21px;
          color: rgba(255, 250, 242, 0.72);
        }

        .footer strong {
          color: var(--paper-strong);
        }
      </style>
    </head>
    <body>
      <div class="card-shell">
        <div class="topbar">
          <div>
            <div class="eyebrow">${escapeHtml(
              analysis.leagueName || "Dynasty League"
            )}</div>
            <h1 class="headline">Trade Completed</h1>
            <div class="meta">${escapeHtml(
              analysis.valueMetaLabel ||
                `${analysis.valueSourceLabel} | Updated ${analysis.valueSourceDateLabel}`
            )}</div>
          </div>
          <div class="winner-chip">
            <div class="winner-chip__label">${escapeHtml(
              analysis.verdictSourceLabel || "Trade Verdict"
            )}</div>
            <div class="winner-chip__value">${escapeHtml(
              analysis.winnerLabel
            )}${analysis.winnerEdgeLabel ? `<br>${escapeHtml(analysis.winnerEdgeLabel)}` : ""}</div>
          </div>
        </div>

        <div class="panels">
          ${teamPanelsHtml}
        </div>

        <div class="footer">
          <div><strong>Trade ID</strong> ${escapeHtml(analysis.tradeId)}</div>
          <div>${escapeHtml(analysis.acceptedAtLabel)}</div>
        </div>
      </div>
    </body>
  </html>`;
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
    <svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
      <defs>
        <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stop-color="${palette.start}" />
          <stop offset="100%" stop-color="${palette.end}" />
        </linearGradient>
      </defs>
      <rect width="144" height="144" rx="34" fill="url(#g)" />
      <rect x="10" y="10" width="124" height="124" rx="28" fill="rgba(0,0,0,0.14)" stroke="rgba(255,255,255,0.18)" />
      <text x="72" y="58" text-anchor="middle" font-size="40" font-family="Trebuchet MS, Arial, sans-serif" font-weight="800" fill="#fff9ef">${escapeXml(
        title
      )}</text>
      <text x="72" y="96" text-anchor="middle" font-size="24" font-family="Trebuchet MS, Arial, sans-serif" font-weight="700" fill="rgba(255,249,239,0.92)">${escapeXml(
        subtitle
      )}</text>
    </svg>
  `;

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function pickPalette(asset) {
  if (asset.type === "pick") {
    return { start: "#6c8cff", end: "#9c6bff" };
  }

  if (asset.type === "faab") {
    return { start: "#1fa880", end: "#61d39f" };
  }

  switch (asset.position) {
    case "QB":
      return { start: "#ff8d63", end: "#ffb678" };
    case "RB":
      return { start: "#6ed8c9", end: "#4da1ff" };
    case "WR":
      return { start: "#ffd166", end: "#ff9d5c" };
    case "TE":
      return { start: "#c98cff", end: "#7d82ff" };
    default:
      return { start: "#7e92a5", end: "#4d6172" };
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
