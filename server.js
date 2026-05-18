const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════════════════════════════════
//  RACE CONFIGURATION
// ═══════════════════════════════════════════════════════════════════
const RACE_CONFIG = {
  name: "GAMBROS × LUXDROP",
  title: "WAGER RACE",
  subtitle: "Open cases on LuxDrop. Climb the leaderboard. Claim your share.",
  startDate: "2026-05-16",
  endDate: "2026-06-15T23:59:59Z",
  // 1st place reward scales with the community's total wager.
  // The tier with the highest minWager <= totalWagered is the active tier.
  prizeTiers: [
    { minWager: 0,      first: 100, second: 0,   third: 0   },
    { minWager: 1000,   first: 200, second: 50,  third: 0   },
    { minWager: 5000,   first: 300, second: 100, third: 50  },
    { minWager: 15000,  first: 400, second: 150, third: 75  },
    { minWager: 30000,  first: 500, second: 200, third: 100 },
  ],
  maxFirstPrize: 500,
  prizePoolLabel: "$500 MAX PRIZE · GROWS WITH WAGER",
  signupLink: "https://luxdrop.com/r/gambros",
  brandLeft: "GAMBROS",
  brandRight: "LUXDROP",
};

// ═══════════════════════════════════════════════════════════════════
//  LUXDROP API
// ═══════════════════════════════════════════════════════════════════
const API_KEY = process.env.API_KEY || "";
const AFFILIATE_CODES = process.env.AFFILIATE_CODES || "gambros";
const LUXDROP_BASE = "https://api.luxdrop.com/external/affiliates";
const RACE_START_ISO = RACE_CONFIG.startDate;
const RACE_END_ISO = RACE_CONFIG.endDate.slice(0, 10);

// ═══════════════════════════════════════════════════════════════════
//  CACHE — 45 second TTL so the API isn't hammered
// ═══════════════════════════════════════════════════════════════════
let apiCache = { time: 0, data: null };
const CACHE_TTL = 45 * 1000;

async function fetchLuxdrop() {
  const now = Date.now();
  if (apiCache.data && now - apiCache.time < CACHE_TTL) {
    return apiCache.data;
  }

  const qs = new URLSearchParams({
    codes: AFFILIATE_CODES,
    startDate: RACE_START_ISO,
    endDate: RACE_END_ISO,
  });
  const url = `${LUXDROP_BASE}?${qs}`;
  console.log(`  ->  Fetching: ${url}`);

  const response = await fetch(url, {
    method: "GET",
    headers: { "x-api-key": API_KEY },
  });

  if (!response.ok) {
    const text = await response.text();
    throw { status: response.status, body: text };
  }

  const json = await response.json();
  apiCache = { time: now, data: json };
  return json;
}

// Walk the JSON tree and pull out anything that looks like a wagering user.
// We accept several common field-name shapes so this is robust to the exact
// response format LuxDrop returns.
function extractPlayers(raw) {
  const out = [];
  const seen = new Set();

  const NAME_KEYS = ["username", "user", "name", "displayName", "playerName", "nickname"];
  const WAGER_KEYS = [
    "wagered", "totalWagered", "amountWagered", "wager", "totalAmountWagered",
    "wagerAmount", "wagerTotal", "totalWager",
  ];
  const DEPOSIT_KEYS = [
    "deposited", "totalDeposited", "deposits", "depositTotal",
    "totalDeposits", "depositAmount",
  ];

  const pickNum = (obj, keys) => {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === "number" && isFinite(v)) return v;
      if (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v))) return Number(v);
    }
    return 0;
  };
  const pickStr = (obj, keys) => {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === "string" && v.trim() !== "") return v.trim();
    }
    return null;
  };

  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node !== "object") return;

    const name = pickStr(node, NAME_KEYS);
    const wagered = pickNum(node, WAGER_KEYS);
    const deposited = pickNum(node, DEPOSIT_KEYS);

    if (name && (wagered > 0 || deposited > 0 || node.userId || node.id)) {
      const key = name.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ username: name, wagered, deposited });
      } else {
        // Merge by name (sum across rows referencing the same user)
        const existing = out.find((p) => p.username.toLowerCase() === key);
        existing.wagered += wagered;
        existing.deposited += deposited;
      }
      return; // don't recurse into a user object
    }

    Object.values(node).forEach(walk);
  };

  walk(raw);
  return out;
}

// Compute the active prize tier and progress toward the next one based on the
// community's total wager. Returns prizes ready to render plus tier metadata.
function computePrizeStatus(totalWagered) {
  const tiers = RACE_CONFIG.prizeTiers;
  let activeIdx = 0;
  for (let i = 0; i < tiers.length; i++) {
    if (totalWagered >= tiers[i].minWager) activeIdx = i;
  }
  const active = tiers[activeIdx];
  const next = tiers[activeIdx + 1] || null;
  const toDollar = (n) => (n > 0 ? `$${n}` : "—");
  return {
    prizes: [
      { place: "1st", reward: toDollar(active.first) },
      { place: "2nd", reward: toDollar(active.second) },
      { place: "3rd", reward: toDollar(active.third) },
    ],
    tierIndex: activeIdx,
    tierCount: tiers.length,
    currentFirst: active.first,
    nextFirst: next ? next.first : null,
    nextThreshold: next ? next.minWager : null,
    remainingToNext: next ? Math.max(0, next.minWager - totalWagered) : 0,
    ladder: tiers.map((t, i) => ({
      first: t.first,
      threshold: t.minWager,
      active: i === activeIdx,
      passed: i < activeIdx,
    })),
  };
}

// ─── Race config endpoint ────────────────────────────────────────
app.get("/race-config", (_req, res) => {
  res.json(RACE_CONFIG);
});

// ─── Leaderboard data endpoint ───────────────────────────────────
app.get("/race-data", async (_req, res) => {
  if (!API_KEY) {
    return res.status(500).json({
      error: "API_KEY environment variable not set.",
    });
  }

  try {
    const raw = await fetchLuxdrop();
    const players = extractPlayers(raw)
      .filter((p) => p.wagered > 0)
      .sort((a, b) => b.wagered - a.wagered)
      .map((p, i) => ({ ...p, rank: i + 1 }));

    const totalWagered = players.reduce((s, p) => s + p.wagered, 0);
    const totalDeposited = players.reduce((s, p) => s + p.deposited, 0);
    const prizeStatus = computePrizeStatus(totalWagered);

    res.json({
      players,
      prizes: prizeStatus.prizes,
      prizeStatus,
      stats: {
        totalWagered,
        totalDeposited,
        playerCount: players.length,
      },
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("  x  API error:", err);
    const status = err.status || 502;
    let msg = "Failed to fetch data from LuxDrop API";
    if (status === 401 || status === 403) msg = "Invalid API key for LuxDrop";
    if (status === 404) msg = "Affiliate code not found";
    res.status(status).json({ error: msg, detail: err.body || null });
  }
});

// ─── Health check ────────────────────────────────────────────────
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// ─── Live Reload via SSE (only when files are watchable) ─────────
const publicDir = path.join(__dirname, "public");
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

try {
  let debounce = null;
  fs.watch(publicDir, { recursive: true }, () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      console.log("  ~  File changed - reloading browsers...");
      reloadClients.forEach((r) => r.write("data: reload\n\n"));
    }, 200);
  });
} catch (_) { /* fs.watch may not work on all platforms; non-fatal */ }

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
  console.log("   GAMBROS × LUXDROP WAGER RACE");
  console.log(`   http://localhost:${PORT}`);
  console.log("  ======================================================");
  console.log("");
  if (!API_KEY) {
    console.log("  !! API_KEY not set. Set it before running:");
    console.log("     export API_KEY=...");
    console.log("     export AFFILIATE_CODES=gambros");
    console.log("");
  } else {
    console.log(`   API Key:  ${API_KEY.slice(0, 4)}****`);
    console.log(`   Codes:    ${AFFILIATE_CODES}`);
    console.log(`   Race:     ${RACE_CONFIG.name} ${RACE_CONFIG.title}`);
    console.log(`   Ends:     ${RACE_CONFIG.endDate}`);
    console.log("");
  }
});
