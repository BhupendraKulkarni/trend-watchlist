const admin = require("firebase-admin");

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

const DEFAULTS = {
  capital: 10000,
  riskPct: 1,
  stopPct: 8,
  targetPct: 20,
  readyThreshold: 3,
};

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Accept": "text/csv,application/json,*/*",
};

const INDEX_SOURCES = [
  "https://nsearchives.nseindia.com/content/indices/ind_nifty50list.csv",
  "https://nsearchives.nseindia.com/content/indices/ind_niftynext50list.csv",
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseCsvLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (const char of line) {
    if (char === '"') inQuotes = !inQuotes;
    else if (char === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else current += char;
  }
  result.push(current.trim());
  return result;
}

async function fetchIndexSymbols(csvUrl) {
  const res = await fetch(csvUrl, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`Failed to fetch ${csvUrl}: ${res.status}`);
  const text = await res.text();
  const lines = text.trim().split("\n").filter(Boolean);
  const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  const symbolIdx = header.findIndex((h) => h.includes("symbol"));
  if (symbolIdx === -1) throw new Error(`No "Symbol" column found in ${csvUrl}`);

  const symbols = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    if (cols[symbolIdx]) symbols.push(cols[symbolIdx]);
  }
  return symbols;
}

async function getUniverse() {
  const lists = await Promise.all(INDEX_SOURCES.map(fetchIndexSymbols));
  const merged = [...new Set(lists.flat())];
  console.log(`Universe loaded: ${merged.length} symbols from ${INDEX_SOURCES.length} index lists.`);
  return merged;
}

const YAHOO_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Accept": "application/json",
};

async function fetchYahooData(symbolWithSuffix) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbolWithSuffix}?range=1y&interval=1d`;
  const res = await fetch(url, { headers: YAHOO_HEADERS });
  if (!res.ok) throw new Error(`Yahoo fetch failed (${res.status})`);
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error("No chart data in response");

  const closesRaw = result.indicators?.quote?.[0]?.close || [];
  const closes = closesRaw.filter((c) => c !== null && c !== undefined);
  if (closes.length < 200) throw new Error(`Only ${closes.length} days of history — need 200+`);

  const cmp = result.meta?.regularMarketPrice ?? closes[closes.length - 1];
  const last50 = closes.slice(-50);
  const last200 = closes.slice(-200);
  const dma50 = last50.reduce((a, b) => a + b, 0) / last50.length;
  const dma200 = last200.reduce((a, b) => a + b, 0) / last200.length;

  return { cmp, dma50, dma200 };
}

async function scanUniverse(symbols) {
  const rows = [];
  for (const symbol of symbols) {
    try {
      const { cmp, dma50, dma200 } = await fetchYahooData(`${symbol}.NS`);
      rows.push({ name: symbol, cmp, dma50, dma200 });
    } catch (err) {
      console.error(`Skipping ${symbol}: ${err.message}`);
    }
    await sleep(200);
  }
  return rows;
}

function computeRow(s, cfg) {
  const ext = ((s.cmp - s.dma50) / s.dma50) * 100;
  const flag = ext > 100 || ext < -50;
  const riskAmount = cfg.capital * (cfg.riskPct / 100);
  const stopPrice = s.cmp * (1 - cfg.stopPct / 100);
  const riskPerShare = s.cmp - stopPrice;
  const qtyByRisk = Math.floor(riskAmount / riskPerShare);
  const qtyByCapital = Math.floor(cfg.capital / s.cmp);
  const qty = Math.min(qtyByRisk, qtyByCapital);

  let status = "watch";
  if (flag) status = "flag";
  else if (s.cmp > s.dma50 && s.dma50 > s.dma200 && ext >= cfg.readyThreshold) status = "ready";
  else if (s.cmp <= s.dma50 || s.dma50 <= s.dma200) status = "not-trending";

  return {
    ...s,
    ext: Number(ext.toFixed(2)),
    stopPrice: Number(stopPrice.toFixed(2)),
    qty: qty > 0 ? qty : 0,
    invested: qty > 0 ? Number((qty * s.cmp).toFixed(2)) : 0,
    affordable: qty >= 1,
    status,
  };
}

async function checkPositions() {
  const snap = await db.collection("positions").where("status", "==", "open").get();
  const updates = [];

  for (const docSnap of snap.docs) {
    const pos = docSnap.data();
    try {
      const { cmp: currentPrice } = await fetchYahooData(`${pos.symbol}.NS`);
      const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
      let action = "HOLD";
      if (currentPrice <= pos.stopPrice) action = "EXIT NOW";
      else if (pos.targetPrice && currentPrice >= pos.targetPrice) action = "TARGET HIT";

      await docSnap.ref.update({
        currentPrice,
        pnlPct: Number(pnlPct.toFixed(2)),
        action,
        lastChecked: new Date().toISOString(),
      });
      updates.push({ symbol: pos.symbol, action, pnlPct: pnlPct.toFixed(2) });
    } catch (err) {
      console.error(`Position check failed for ${pos.symbol}: ${err.message}`);
    }
    await sleep(200);
  }
  return updates;
}

async function run() {
  const configSnap = await db.doc("config/settings").get();
  const cfg = configSnap.exists ? { ...DEFAULTS, ...configSnap.data() } : DEFAULTS;

  const universe = await getUniverse();
  const raw = await scanUniverse(universe);
  const rows = raw.map((s) => computeRow(s, cfg));

  await db.doc("watchlist/latest").set({
    updatedAt: new Date().toISOString(),
    config: cfg,
    rows,
  });

  const positionUpdates = await checkPositions();

  console.log(`Scan complete. ${rows.length}/${universe.length} symbols scanned, ${rows.filter(r => r.status === "ready").length} ready.`);
  console.log(`Positions checked: ${positionUpdates.length}`, positionUpdates);
}

run().catch((err) => {
  console.error("Scan failed:", err);
  process.exit(1);
});
