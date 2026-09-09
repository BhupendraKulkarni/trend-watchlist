const admin = require("firebase-admin");
const cheerio = require("cheerio");

// Service account JSON comes from a GitHub Secret (see workflow file) — never hardcode it here.
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

const SCREEN_URL = "https://www.screener.in/screens/1366013/above-50-200-ema/?limit=200";

async function scrapeScreener() {
  const res = await fetch(SCREEN_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; TrendWatchlistBot/1.0)" },
  });
  if (!res.ok) throw new Error(`Screener fetch failed: ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  let $table = null;
  $("table").each((_, table) => {
    const headerText = $(table).find("thead").text();
    if (/CMP/i.test(headerText)) {
      $table = $(table);
      return false;
    }
  });
  if (!$table) throw new Error("Could not locate the results table on Screener.in — page structure may have changed.");

  const headers = [];
  $table.find("thead th").each((_, th) => headers.push($(th).text().trim().toLowerCase()));

  const companyIdx = headers.findIndex((h) => h.includes("company"));
  const cmpIdx = headers.findIndex((h) => h.includes("cmp"));
  const dma200Idx = headers.findIndex((h) => h.includes("200 dma"));
  const dma50Idx = headers.findIndex((h) => h.includes("50 dma"));

  if ([companyIdx, cmpIdx, dma200Idx, dma50Idx].includes(-1)) {
    throw new Error(`Expected columns not found in headers: ${JSON.stringify(headers)}`);
  }

  const rows = [];
  $table.find("tbody tr").each((_, tr) => {
    const cells = $(tr).find("td");
    if (!cells.length) return;

    const name = $(cells[companyIdx]).text().trim();
    const cmp = parseFloat($(cells[cmpIdx]).text().replace(/,/g, ""));
    const dma200 = parseFloat($(cells[dma200Idx]).text().replace(/,/g, ""));
    const dma50 = parseFloat($(cells[dma50Idx]).text().replace(/,/g, ""));

    if (name && !isNaN(cmp) && !isNaN(dma50) && !isNaN(dma200)) {
      rows.push({ name, cmp, dma50, dma200 });
    }
  });
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
  else if (ext >= cfg.readyThreshold) status = "ready";

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

async function fetchCurrentPrice(symbol) {
  const url = `https://www.screener.in/company/${symbol}/consolidated/`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; TrendWatchlistBot/1.0)" },
  });
  if (!res.ok) throw new Error(`Price fetch failed for ${symbol}: ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  let price = NaN;
  $("li").each((_, li) => {
    const $li = $(li);
    if (/current price/i.test($li.text())) {
      const numText = $li.find(".number").first().text().replace(/,/g, "").trim();
      const parsed = parseFloat(numText);
      if (!isNaN(parsed)) {
        price = parsed;
        return false;
      }
    }
  });

  if (isNaN(price)) throw new Error(`Could not parse Current Price for ${symbol} — page structure may have changed.`);
  return price;
}

async function checkPositions() {
  const snap = await db.collection("positions").where("status", "==", "open").get();
  const updates = [];

  for (const docSnap of snap.docs) {
    const pos = docSnap.data();
    try {
      const currentPrice = await fetchCurrentPrice(pos.symbol);
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
      console.error(`Position check failed for ${pos.symbol}:`, err.message);
    }
  }
  return updates;
}

async function run() {
  const configSnap = await db.doc("config/settings").get();
  const cfg = configSnap.exists ? { ...DEFAULTS, ...configSnap.data() } : DEFAULTS;

  const raw = await scrapeScreener();
  const rows = raw.map((s) => computeRow(s, cfg));

  await db.doc("watchlist/latest").set({
    updatedAt: new Date().toISOString(),
    config: cfg,
    rows,
  });

  const positionUpdates = await checkPositions();

  console.log(`Scan complete. ${rows.length} stocks scanned, ${rows.filter(r => r.status === "ready").length} ready.`);
  console.log(`Positions checked: ${positionUpdates.length}`, positionUpdates);
}

run().catch((err) => {
  console.error("Scan failed:", err);
  process.exit(1);
});
