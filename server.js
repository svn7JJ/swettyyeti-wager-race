const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════════════════════════════════
//  RACE CONFIGURATION
// ═══════════════════════════════════════════════════════════════════
const RACE_CONFIG = {
  name: "MAY MADNESS WAGER RACE",
  subtitle: "Wager the most on Damble to climb the leaderboard",
  startDate: "2026-05-01",
  endDate: "2026-06-01",
  prizes: [
    { place: "1st", reward: "$150" },
    { place: "2nd", reward: "$75" },
    { place: "3rd", reward: "$25" },
  ],
  signupLink: "https://www.damble.io/?dialog=auth&tab=register&referralCode=damble-Swettyyeti",
  brandName: "SWETTYYETI",
};

const RACE_BASELINES = {
  TomDonkey: { wagered: 18994.29, bets: 7507 },
  Jessica25: { wagered: 17073.12, bets: 10848 },
  ItsPigeon: { wagered: 5382.27, bets: 8230 },
  Itsjace03: { wagered: 3841.38, bets: 1188 },
  Gilly92: { wagered: 2585.38, bets: 1706 },
  Nurser: { wagered: 444.18, bets: 171 },
  Kaarrrllll: { wagered: 356.24, bets: 627 },
  Adam32: { wagered: 345.21, bets: 313 },
  marns2x: { wagered: 218.38, bets: 38 },
};

// ═══════════════════════════════════════════════════════════════════
//  API CREDENTIALS
// ═══════════════════════════════════════════════════════════════════
const API_KEY = process.env.API_KEY || "";
const PARTNER_EMAIL = process.env.PARTNER_EMAIL || "";
const DAMBLE_BASE = "https://server.damble.io/api/v1/partners";

// ═══════════════════════════════════════════════════════════════════
//  API CACHE — 60 second TTL
// ═══════════════════════════════════════════════════════════════════
let apiCache = {};
const CACHE_TTL = 60 * 1000;

async function cachedFetch(endpoint) {
  const now = Date.now();
  if (apiCache[endpoint] && (now - apiCache[endpoint].time) < CACHE_TTL) {
    return apiCache[endpoint].data;
  }

  const url = DAMBLE_BASE + endpoint;
  console.log(`  ->  Fetching: ${url}`);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "x-api-key": API_KEY,
      "x-partner-email": PARTNER_EMAIL,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw { status: response.status, body: text };
  }

  const json = await response.json();
  apiCache[endpoint] = { time: now, data: json };
  return json;
}

// ─── Race config endpoint ────────────────────────────────────────
app.get("/race-config", (_req, res) => {
  res.json(RACE_CONFIG);
});

// ─── Leaderboard data endpoint ───────────────────────────────────
app.get("/race-data", async (_req, res) => {
  if (!API_KEY || !PARTNER_EMAIL) {
    return res.status(500).json({
      error: "Credentials not set. Run with: set API_KEY=... && set PARTNER_EMAIL=... && node server.js",
    });
  }

  try {
    const [usersJson, overviewJson] = await Promise.all([
      cachedFetch("/affiliate/stats/earnings-per-user"),
      cachedFetch("/affiliate/stats/overview"),
    ]);

    const users = usersJson.data || usersJson;
    const overviewRaw = overviewJson.data || overviewJson;
    const overview = overviewRaw.overview || overviewRaw;

    if (!Array.isArray(users) || users.length === 0) {
      return res.status(200).json({
        players: [],
        stats: { totalWagered: 0, totalBets: 0, playerCount: 0, activeCount: 0 },
      });
    }

    const players = users
      .map((u) => {
        const username = u.username || "Unknown";
        const baseline = RACE_BASELINES[username] || { wagered: 0, bets: 0 };
        return {
          username,
          wagered: Math.max(0, (u.totalAmountWagered || 0) - baseline.wagered),
          bets: Math.max(0, (u.totalBetsPlaced || 0) - baseline.bets),
          isActive: u.isActive || false,
        };
      })
      .filter((p) => p.wagered > 0 || p.bets > 0)
      .sort((a, b) => b.wagered - a.wagered)
      .map((p, i) => ({ ...p, rank: i + 1 }));

    const totalWagered = players.reduce((s, p) => s + p.wagered, 0);
    const totalBets = players.reduce((s, p) => s + p.bets, 0);
    const activeCount = players.filter((p) => p.isActive).length;

    res.json({
      players: players,
      stats: {
        totalWagered: totalWagered,
        totalBets: totalBets,
        playerCount: players.length,
        activeCount: activeCount,
      },
    });
  } catch (err) {
    console.error("  x  API error:", err);
    const status = err.status || 502;
    let msg = "Failed to fetch data from Damble API";
    if (status === 401) msg = "Invalid API key or email";
    if (status === 403) msg = "Account is not an affiliate partner";
    res.status(status).json({ error: msg });
  }
});

// ─── Live Reload via SSE ─────────────────────────────────────────
let reloadClients = [];
app.get("/__reload", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("data: connected\n\n");
  reloadClients.push(res);
  req.on("close", () => {
    reloadClients = reloadClients.filter((c) => c !== res);
  });
});

const publicDir = path.join(__dirname, "public");
let debounce = null;
fs.watch(publicDir, { recursive: true }, () => {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    console.log("  ~  File changed - reloading browsers...");
    reloadClients.forEach((r) => r.write("data: reload\n\n"));
  }, 200);
});

// ─── Serve frontend ──────────────────────────────────────────────
app.use(
  express.static(publicDir, {
    etag: false,
    lastModified: false,
    setHeaders: (res) => res.setHeader("Cache-Control", "no-store"),
  })
);

// ─── Start ───────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log("");
  console.log("  ======================================================");
  console.log("   SWETTYYETI WAGER RACE");
  console.log(`   http://localhost:${PORT}`);
  console.log("   Live reload: ON");
  console.log("  ======================================================");
  console.log("");
  if (!API_KEY || !PARTNER_EMAIL) {
    console.log("  !! Credentials not set. Run with:");
    console.log("");
    console.log("     set API_KEY=uRWYw3Uxfb");
    console.log("     set PARTNER_EMAIL=J_ingram182@hotmail.com");
    console.log("     node server.js");
    console.log("");
  } else {
    console.log(`   API Key:  ${API_KEY.slice(0, 4)}****`);
    console.log(`   Email:    ${PARTNER_EMAIL}`);
    console.log(`   Race:     ${RACE_CONFIG.name}`);
    console.log(`   Period:   ${RACE_CONFIG.startDate} -> ${RACE_CONFIG.endDate}`);
    console.log("");
    console.log("   Edit files in /public - browser refreshes automatically.");
    console.log("");
  }
});
