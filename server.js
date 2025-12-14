import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const app = express();
app.use(express.json({ limit: "1mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const TIINGO_TOKEN = process.env.TIINGO_TOKEN || "";

/**
 * SMTA Signal Engine (SSE)
 * - EOD data (Tiingo)
 * - Multi-horizon momentum + vol targeting + regime filter + no-trade zone
 * - Actionable: buy/sell + sizing + rebalance + hold estimate
 * - Benchmark: walk-forward rebalance backtest vs SPY buy&hold (simple slippage)
 *
 * NOTE: This is an analytics tool. You execute manually.
 */

function assertToken() {
  if (!TIINGO_TOKEN || TIINGO_TOKEN.trim().length < 8) {
    const err = new Error("Missing TIINGO_TOKEN. Set it as an environment variable on Render.");
    err.status = 400;
    throw err;
  }
}

function iso(d) {
  return new Date(d).toISOString().slice(0, 10);
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return iso(d);
}

function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
function mean(arr) { return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0; }
function stdev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const v = mean(arr.map(x => (x - m) * (x - m)));
  return Math.sqrt(v);
}
function maxDrawdown(equity) {
  let peak = -Infinity;
  let mdd = 0;
  for (const e of equity) {
    peak = Math.max(peak, e);
    const dd = peak > 0 ? (peak - e) / peak : 0;
    mdd = Math.max(mdd, dd);
  }
  return mdd;
}

// Small concurrency limiter so you don't nuke Tiingo / get random 429s.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

async function tiingoPrices(ticker, startDate, endDate) {
  assertToken();
  const url = new URL(`https://api.tiingo.com/tiingo/daily/${encodeURIComponent(ticker)}/prices`);
  url.searchParams.set("startDate", startDate);
  url.searchParams.set("endDate", endDate);
  url.searchParams.set("token", TIINGO_TOKEN);
  url.searchParams.set("resampleFreq", "daily");
  url.searchParams.set("columns", "date,adjClose,close,volume");

  const res = await fetch(url.toString(), { headers: { "Content-Type": "application/json" } });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Tiingo error for ${ticker}: HTTP ${res.status} — ${text.slice(0, 200)}`);
    err.status = 502;
    throw err;
  }
  const json = JSON.parse(text);
  if (!Array.isArray(json) || json.length === 0) {
    const err = new Error(`No Tiingo data for ${ticker}.`);
    err.status = 404;
    throw err;
  }

  return json.map(r => ({
    date: (r.date || "").toString().slice(0, 10),
    close: Number.isFinite(r.adjClose) ? Number(r.adjClose) : Number(r.close),
    rawClose: Number(r.close),
    volume: Number(r.volume || 0)
  })).filter(r => r.date && Number.isFinite(r.close));
}

function computeDailyReturns(series) {
  const rets = [];
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1].close;
    const cur = series[i].close;
    if (prev > 0 && cur > 0) rets.push(Math.log(cur / prev));
  }
  return rets;
}

function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(values.length - period);
  return mean(slice);
}

function momentumScore(series) {
  const closes = series.map(x => x.close);
  const n = closes.length;
  const look = (d) => (n > d ? Math.log(closes[n - 1] / closes[n - 1 - d]) : 0);

  const r21 = look(21);
  const r63 = look(63);
  const r126 = look(126);
  const r252 = look(252);

  const accel = r21 - r63;
  const score = (0.10 * r21 + 0.20 * r63 + 0.30 * r126 + 0.40 * r252) + 0.15 * accel;
  return { score, r21, r63, r126, r252, accel };
}

function realizedVol(series, window = 63) {
  const rets = computeDailyReturns(series);
  const slice = rets.slice(-window);
  const v = stdev(slice) * Math.sqrt(252);
  return Number.isFinite(v) ? v : 0;
}

function monthSeasonalityTilt(series, todayDateStr) {
  const month = Number(todayDateStr.slice(5, 7));
  const byMonth = new Map();
  let prevMonth = null;
  let prevClose = null;

  for (const r of series) {
    const m = Number(r.date.slice(5, 7));
    if (prevMonth === null) { prevMonth = m; prevClose = r.close; continue; }
    if (m !== prevMonth) {
      const ret = Math.log(r.close / prevClose);
      if (!byMonth.has(prevMonth)) byMonth.set(prevMonth, []);
      byMonth.get(prevMonth).push(ret);
      prevMonth = m;
      prevClose = r.close;
    }
  }

  const all = Array.from(byMonth.values()).flat();
  const overall = mean(all);
  const cur = mean(byMonth.get(month) || []);
  const tilt = clamp(cur - overall, -0.01, 0.01);
  return Number.isFinite(tilt) ? tilt : 0;
}

function detectRegime(spySeries) {
  const closes = spySeries.map(x => x.close);
  const sma200 = sma(closes, 200);
  const sma50 = sma(closes, 50);
  const last = closes[closes.length - 1];

  const vol20 = stdev(computeDailyReturns(spySeries).slice(-20)) * Math.sqrt(252);
  const volSpike = vol20 > 0.22;

  if (sma200 === null || sma50 === null) return { regime: "unknown", detail: "Not enough history", vol20, volSpike };
  const riskOn = (last > sma200) && (sma50 > sma200);

  if (riskOn && !volSpike) return { regime: "risk_on", detail: "SPY > SMA200 and SMA50>SMA200", vol20, volSpike };
  if (riskOn && volSpike) return { regime: "caution", detail: "Risk-on trend but volatility spike", vol20, volSpike };
  return { regime: "risk_off", detail: "SPY under long-term trend", vol20, volSpike };
}

function invVolWeights(items, minVol = 0.05, maxVol = 1.5) {
  const inv = items.map(it => 1 / clamp(it.vol, minVol, maxVol));
  const s = inv.reduce((a, b) => a + b, 0) || 1;
  return inv.map(v => v / s);
}

function nextRebalanceDate(latestDate, cadence) {
  const d = new Date(latestDate + "T00:00:00Z");
  if (cadence === "monthly") {
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    const next = new Date(Date.UTC(y, m + 2, 0));
    return iso(next);
  }
  const day = d.getUTCDay(); // 0..6
  const delta = (5 - day + 7) % 7 || 7;
  d.setUTCDate(d.getUTCDate() + delta);
  return iso(d);
}

function normalizeHoldings(holdings) {
  const out = [];
  for (const h of (holdings || [])) {
    const t = (h.ticker || "").toUpperCase().trim();
    const shares = Number(h.shares || 0);
    const avgCost = Number(h.avgCost || 0);
    const lastTradeDate = (h.lastTradeDate || "").slice(0, 10);
    if (!t || !Number.isFinite(shares)) continue;
    out.push({ ticker: t, shares, avgCost, lastTradeDate: lastTradeDate || null });
  }
  return out;
}

function parseHoldingsCSV(text) {
  const lines = (text || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const rows = lines.map(l => l.split(",").map(x => x.trim()));
  const first = rows[0].map(x => x.toLowerCase());
  const hasHeader = first.includes("ticker") || first.includes("shares");
  const data = hasHeader ? rows.slice(1) : rows;

  return data.map(r => ({
    ticker: r[0],
    shares: Number(r[1] || 0),
    avgCost: Number(r[2] || 0),
    lastTradeDate: r[3] || ""
  })).filter(r => r.ticker);
}

function computeTrades(target, pricesNow, holdings, capital, noTradePct, minHoldDays, asOfDate) {
  const h = new Map();
  for (const x of holdings) h.set(x.ticker, x);

  const current = [];
  let totalValue = 0;
  for (const [t, obj] of h.entries()) {
    const px = pricesNow.get(t);
    if (!px || px <= 0) continue;
    const mv = obj.shares * px;
    current.push({ ticker: t, shares: obj.shares, price: px, value: mv, lastTradeDate: obj.lastTradeDate });
    totalValue += mv;
  }
  const effectiveCapital = Math.max(capital || 0, totalValue || 0, 0);

  const curW = new Map();
  for (const c of current) curW.set(c.ticker, totalValue > 0 ? c.value / totalValue : 0);

  const tgtW = new Map();
  for (const t of target) tgtW.set(t.ticker, t.weight);

  const all = new Set([...curW.keys(), ...tgtW.keys()]);
  const trades = [];

  for (const ticker of all) {
    const cw = curW.get(ticker) || 0;
    const tw = tgtW.get(ticker) || 0;
    const delta = tw - cw;
    const absDelta = Math.abs(delta);

    const price = pricesNow.get(ticker) || 0;
    if (price <= 0) continue;

    if (absDelta < (noTradePct / 100)) continue;

    const holding = h.get(ticker);
    if (holding && delta < 0 && holding.lastTradeDate) {
      const daysHeld = (new Date(asOfDate) - new Date(holding.lastTradeDate)) / (1000 * 60 * 60 * 24);
      if (daysHeld < minHoldDays) {
        trades.push({
          action: "HOLD",
          ticker,
          shares: 0,
          price,
          estValue: 0,
          reason: `Min holding period (${minHoldDays}d) not met (held ~${daysHeld.toFixed(0)}d).`
        });
        continue;
      }
    }

    const dollar = delta * effectiveCapital;
    const rawShares = dollar / price;
    const shares = Math.round(rawShares);
    if (shares === 0) continue;

    trades.push({
      action: shares > 0 ? "BUY" : "SELL",
      ticker,
      shares: Math.abs(shares),
      price,
      estValue: Math.abs(shares) * price,
      reason: `Rebalance delta ${(delta * 100).toFixed(1)}% (no-trade threshold ${noTradePct}%).`
    });
  }

  trades.sort((a, b) => (a.action === "SELL" ? -1 : 1) - (b.action === "SELL" ? -1 : 1));
  return { effectiveCapital, totalValue, trades };
}

async function buildSignals(opts) {
  const { universe, cadence, topN, minMomentum, defensiveTickers, targetVol, seasonalityWeight } = opts;

  const endDate = iso(new Date());
  const startDate = addDays(endDate, -900);

  const uniqueTickers = Array.from(new Set([...universe, "SPY"]));
  const seriesByTicker = new Map();

  await mapLimit(uniqueTickers, 4, async (t) => {
    const s = await tiingoPrices(t, startDate, endDate);
    seriesByTicker.set(t, s);
  });

  const spy = seriesByTicker.get("SPY");
  const asOf = spy[spy.length - 1].date;
  const regime = detectRegime(spy);

  const feats = [];
  for (const t of universe) {
    const s = seriesByTicker.get(t);
    if (!s || s.length < 260) continue;
    const mom = momentumScore(s);
    const vol = realizedVol(s, 63);
    const seas = monthSeasonalityTilt(s, asOf);
    const adj = mom.score + (seasonalityWeight * seas);
    feats.push({ ticker: t, mom, vol, seas, score: adj });
  }

  const sorted = feats.sort((a, b) => b.score - a.score);
  let selected = [];
  let rationale = "";

  if (regime.regime === "risk_off") {
    const def = sorted.filter(x => defensiveTickers.includes(x.ticker));
    selected = def.slice(0, Math.max(1, Math.min(topN, def.length)));
    rationale = "Risk-off: allocate into defensive leaders (momentum + vol).";
  } else if (regime.regime === "caution") {
    const def = sorted.filter(x => defensiveTickers.includes(x.ticker)).slice(0, Math.max(1, Math.floor(topN / 2)));
    const risk = sorted.filter(x => !defensiveTickers.includes(x.ticker)).slice(0, Math.max(1, topN - def.length));
    selected = [...def, ...risk].slice(0, topN);
    rationale = "Caution: blend defensive + top risk assets due to volatility spike.";
  } else {
    selected = sorted.slice(0, topN);
    rationale = "Risk-on: allocate into top momentum assets (with vol sizing).";
  }

  const weak = selected.filter(x => x.score < minMomentum);
  if (weak.length) {
    const fallback = sorted.filter(x => defensiveTickers.includes(x.ticker)).slice(0, topN);
    if (fallback.length) {
      selected = fallback;
      rationale += " Minimum-momentum gate tripped; shifted to defensive.";
    }
  }

  const baseW = invVolWeights(selected);
  const portVol = Math.sqrt(selected.reduce((s, it, i) => s + (baseW[i] * baseW[i] * it.vol * it.vol), 0)) || 0;
  const scale = (portVol > 0 && targetVol > 0) ? clamp(targetVol / portVol, 0.5, 1.25) : 1;
  const scaledW = baseW.map(w => w * scale);
  const sumW = scaledW.reduce((a, b) => a + b, 0) || 1;
  const finalW = scaledW.map(w => w / sumW);

  const target = selected.map((it, i) => ({
    ticker: it.ticker,
    weight: Number(finalW[i].toFixed(4)),
    vol: Number(it.vol.toFixed(4)),
    score: Number(it.score.toFixed(6)),
    mom: { r21: it.mom.r21, r63: it.mom.r63, r126: it.mom.r126, r252: it.mom.r252, accel: it.mom.accel },
    seasonality: Number(it.seas.toFixed(6)),
    rationale
  }));

  const holdEstimateDays = selected.length
    ? Math.round(clamp(12 + (selected[0].score * 180), 10, 90))
    : 21;

  const nextReb = nextRebalanceDate(asOf, cadence);
  return { asOf, regime, target, nextRebalance: nextReb, holdEstimateDays, seriesByTicker };
}

// ---- Backtest helpers (unchanged from your file, but kept intact) ----

function pickRebalanceDates(commonDates, cadence) {
  const dates = commonDates.slice().sort();
  if (dates.length < 10) return [];

  if (cadence === "monthly") {
    const out = [];
    let curYM = null;
    let lastInMonth = null;
    for (const d of dates) {
      const ym = d.slice(0, 7);
      if (curYM === null) { curYM = ym; lastInMonth = d; continue; }
      if (ym !== curYM) {
        out.push(lastInMonth);
        curYM = ym;
      }
      lastInMonth = d;
    }
    if (lastInMonth) out.push(lastInMonth);
    return out;
  }

  const out = [];
  let curWeek = null;
  let lastInWeek = null;

  function isoWeekKey(d) {
    const dt = new Date(d + "T00:00:00Z");
    const tmp = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
    tmp.setUTCDate(tmp.getUTCDate() + 4 - (tmp.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((tmp - yearStart) / 86400000) + 1) / 7);
    return `${tmp.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
  }

  for (const d of dates) {
    const wk = isoWeekKey(d);
    if (curWeek === null) { curWeek = wk; lastInWeek = d; continue; }
    if (wk !== curWeek) {
      out.push(lastInWeek);
      curWeek = wk;
    }
    lastInWeek = d;
  }
  if (lastInWeek) out.push(lastInWeek);
  return out;
}

function alignSeries(seriesByTicker, tickers) {
  const dateSets = tickers.map(t => new Set((seriesByTicker.get(t) || []).map(r => r.date)));
  let common = dateSets[0];
  for (let i = 1; i < dateSets.length; i++) {
    const next = new Set();
    for (const d of common) if (dateSets[i].has(d)) next.add(d);
    common = next;
  }
  const commonDates = Array.from(common).sort();
  const closeMap = new Map();
  for (const t of tickers) {
    const m = new Map();
    for (const r of (seriesByTicker.get(t) || [])) if (common.has(r.date)) m.set(r.date, r.close);
    closeMap.set(t, m);
  }
  return { commonDates, closeMap };
}

function buildWindowSeries(series, endDate, lookbackDays) {
  const idx = series.findIndex(r => r.date === endDate);
  const endIdx = idx >= 0 ? idx : series.length - 1;
  const startIdx = Math.max(0, endIdx - (lookbackDays + 20));
  return series.slice(startIdx, endIdx + 1);
}

function computeWeightsAtDate(date, seriesByTicker, universe, opts) {
  const spySeries = buildWindowSeries(seriesByTicker.get("SPY"), date, 400);
  const regime = detectRegime(spySeries);

  const feats = [];
  for (const t of universe) {
    const s = buildWindowSeries(seriesByTicker.get(t), date, 900);
    if (!s || s.length < 260) continue;
    const mom = momentumScore(s);
    const vol = realizedVol(s, 63);
    const seas = monthSeasonalityTilt(s, date);
    const adj = mom.score + (opts.seasonalityWeight * seas);
    feats.push({ ticker: t, mom, vol, seas, score: adj });
  }
  feats.sort((a, b) => b.score - a.score);

  let selected = [];
  if (regime.regime === "risk_off") {
    selected = feats.filter(x => opts.defensiveTickers.includes(x.ticker)).slice(0, opts.topN);
  } else if (regime.regime === "caution") {
    const def = feats.filter(x => opts.defensiveTickers.includes(x.ticker)).slice(0, Math.max(1, Math.floor(opts.topN / 2)));
    const risk = feats.filter(x => !opts.defensiveTickers.includes(x.ticker)).slice(0, Math.max(1, opts.topN - def.length));
    selected = [...def, ...risk].slice(0, opts.topN);
  } else {
    selected = feats.slice(0, opts.topN);
  }

  if (selected.some(x => x.score < opts.minMomentum)) {
    const fb = feats.filter(x => opts.defensiveTickers.includes(x.ticker)).slice(0, opts.topN);
    if (fb.length) selected = fb;
  }

  const baseW = invVolWeights(selected);
  const portVol = Math.sqrt(selected.reduce((s, it, i) => s + (baseW[i] * baseW[i] * it.vol * it.vol), 0)) || 0;
  const scale = (portVol > 0 && opts.targetVol > 0) ? clamp(opts.targetVol / portVol, 0.5, 1.25) : 1;
  const scaledW = baseW.map(w => w * scale);
  const sumW = scaledW.reduce((a, b) => a + b, 0) || 1;
  const w = scaledW.map(x => x / sumW);

  const weights = new Map();
  selected.forEach((it, i) => weights.set(it.ticker, w[i]));
  return { regime, weights };
}

function backtest(seriesByTicker, universe, opts) {
  const tickers = Array.from(new Set(["SPY", ...universe]));
  const { commonDates, closeMap } = alignSeries(seriesByTicker, tickers);
  const startIdx = 260;
  const dates = commonDates.slice(startIdx);
  const rebDates = new Set(pickRebalanceDates(dates, opts.cadence));

  let equitySSE = 1.0;
  let equitySPY = 1.0;
  const curve = [];
  const curveSPY = [];
  const daily = [];

  let weights = new Map();
  let trades = 0;
  let turnoverSum = 0;

  for (let i = 1; i < dates.length; i++) {
    const dPrev = dates[i - 1];
    const d = dates[i];

    if (rebDates.has(d)) {
      const wAt = computeWeightsAtDate(d, seriesByTicker, universe, opts).weights;
      let turnover = 0;
      const all = new Set([...weights.keys(), ...wAt.keys()]);
      for (const t of all) turnover += Math.abs((wAt.get(t) || 0) - (weights.get(t) || 0));
      turnover *= 0.5;
      turnoverSum += turnover;
      if (turnover > 0.0001) trades += 1;

      const slip = (opts.slippageBps / 10000) * turnover;
      equitySSE *= (1 - slip);

      weights = wAt;
    }

    let r = 0;
    for (const [t, w] of weights.entries()) {
      const pxPrev = closeMap.get(t).get(dPrev);
      const px = closeMap.get(t).get(d);
      if (pxPrev && px) r += w * (px / pxPrev - 1);
    }
    equitySSE *= (1 + r);

    const spyPrev = closeMap.get("SPY").get(dPrev);
    const spyNow = closeMap.get("SPY").get(d);
    const rSpy = (spyPrev && spyNow) ? (spyNow / spyPrev - 1) : 0;
    equitySPY *= (1 + rSpy);

    curve.push(equitySSE);
    curveSPY.push(equitySPY);
    daily.push({ date: d, sse: equitySSE, spy: equitySPY });
  }

  const totalDays = daily.length || 1;
  const years = totalDays / 252;
  const cagrSSE = Math.pow(curve[curve.length - 1] || 1, 1 / Math.max(0.0001, years)) - 1;
  const cagrSPY = Math.pow(curveSPY[curveSPY.length - 1] || 1, 1 / Math.max(0.0001, years)) - 1;

  const sseR = [];
  const spyR = [];
  for (let i = 1; i < daily.length; i++) {
    sseR.push(daily[i].sse / daily[i - 1].sse - 1);
    spyR.push(daily[i].spy / daily[i - 1].spy - 1);
  }

  const volSSE = stdev(sseR) * Math.sqrt(252);
  const volSPY = stdev(spyR) * Math.sqrt(252);
  const sharpeSSE = volSSE > 0 ? (mean(sseR) * 252) / volSSE : 0;
  const sharpeSPY = volSPY > 0 ? (mean(spyR) * 252) / volSPY : 0;

  const mddSSE = maxDrawdown(curve);
  const mddSPY = maxDrawdown(curveSPY);

  const metrics = {
    period: { start: daily[0]?.date || null, end: daily[daily.length - 1]?.date || null, years: Number(years.toFixed(2)) },
    sse: { totalReturn: (curve[curve.length - 1] || 1) - 1, cagr: cagrSSE, vol: volSSE, sharpe: sharpeSSE, maxDrawdown: mddSSE },
    spy: { totalReturn: (curveSPY[curveSPY.length - 1] || 1) - 1, cagr: cagrSPY, vol: volSPY, sharpe: sharpeSPY, maxDrawdown: mddSPY },
    activity: { rebalances: trades, avgTurnover: trades ? (turnoverSum / trades) : turnoverSum, slippageBps: opts.slippageBps }
  };

  return { daily, metrics };
}

function defaultUniverse(mode) {
  if (mode === "stocks") {
    return ["AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","JPM","XOM","UNH","COST","AVGO","LLY","PEP","HD"];
  }
  return ["SPY","QQQ","IWM","EFA","EEM","TLT","IEF","GLD","DBC","VNQ"];
}

function defaultDefensive(universe) {
  const set = new Set(universe);
  const candidates = ["TLT","IEF","SHY","GLD","USMV","SPLV"];
  const out = candidates.filter(t => set.has(t));
  if (out.length) return out;
  // If user universe doesn't contain known defensive assets, fall back to "first few" tickers.
  return universe.slice(0, Math.min(3, universe.length));
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), hasTiingoToken: Boolean(TIINGO_TOKEN) });
});

app.post("/api/plan", async (req, res, next) => {
  try {
    const body = req.body || {};
    const universeMode = (body.universeMode || "etf").toLowerCase();
    const customTickers = Array.isArray(body.customTickers) ? body.customTickers : [];

    let universe = (universeMode === "custom")
      ? customTickers.map(t => String(t).toUpperCase().trim()).filter(Boolean)
      : defaultUniverse(universeMode === "stocks" ? "stocks" : "etf");

    // SPY is reserved for regime/benchmark. Never allow it in the traded universe.
    universe = Array.from(new Set(universe)).filter(t => t && t !== "SPY");

    if (!universe.length) {
      const err = new Error("Universe is empty. Provide custom tickers or choose a preset.");
      err.status = 400;
      throw err;
    }

    const cadence = (body.cadence || "weekly").toLowerCase();
    const topN = clamp(Number(body.topN || (universeMode === "stocks" ? 5 : 3)), 1, 8);
    const minMomentum = Number(body.minMomentum ?? 0);
    const targetVol = clamp(Number(body.targetVol ?? 0.12), 0.05, 0.30);
    const seasonalityWeight = clamp(Number(body.seasonalityWeight ?? 0.05), 0, 0.20);
    const slippageBps = clamp(Number(body.slippageBps ?? 5), 0, 50);

    const noTradePct = clamp(Number(body.noTradePct ?? 5), 0, 25);
    const minHoldDays = clamp(Number(body.minHoldDays ?? 10), 0, 90);

    const capital = clamp(Number(body.capital ?? 100000), 0, 1e9);

    const holdingsText = String(body.holdingsCsv || "");
    const holdings = normalizeHoldings(parseHoldingsCSV(holdingsText));

    let defensiveTickers = Array.isArray(body.defensiveTickers) && body.defensiveTickers.length
      ? body.defensiveTickers.map(t => String(t).toUpperCase().trim()).filter(Boolean)
      : defaultDefensive(universe);

    // Defensive tickers must be a subset of the universe.
    const uSet = new Set(universe);
    defensiveTickers = defensiveTickers.filter(t => uSet.has(t));
    if (!defensiveTickers.length) defensiveTickers = defaultDefensive(universe);

    const opts = { universe, cadence, topN, minMomentum, defensiveTickers, targetVol, seasonalityWeight, slippageBps };

    const signals = await buildSignals(opts);

    const pricesNow = new Map();
    for (const t of universe) {
      const s = signals.seriesByTicker.get(t);
      if (!s || !s.length) continue;
      pricesNow.set(t, s[s.length - 1].close);
    }

    const tradePlan = computeTrades(signals.target, pricesNow, holdings, capital, noTradePct, minHoldDays, signals.asOf);

    // Walk-forward backtest (uses same opts)
    const bt = backtest(signals.seriesByTicker, universe, opts);

    res.json({
      asOf: signals.asOf,
      nextRebalance: signals.nextRebalance,
      holdEstimateDays: signals.holdEstimateDays,
      regime: signals.regime,
      universe,
      defensiveTickers,
      target: signals.target,
      trades: tradePlan.trades,
      effectiveCapital: tradePlan.effectiveCapital,
      currentHoldingsValue: tradePlan.totalValue,
      backtest: bt
    });
  } catch (e) {
    next(e);
  }
});

// ---- Static/UI serving (works with /public OR root index.html) ----
const publicDir = path.join(__dirname, "public");
const publicIndex = path.join(publicDir, "index.html");
const rootIndex = path.join(__dirname, "index.html");

const hasPublicDir = fs.existsSync(publicDir);
const hasPublicIndex = fs.existsSync(publicIndex);
const hasRootIndex = fs.existsSync(rootIndex);

if (hasPublicDir) app.use(express.static(publicDir));
app.use(express.static(__dirname)); // also allow root assets if you keep them there

app.get("/", (req, res) => {
  if (hasPublicIndex) return res.sendFile(publicIndex);
  if (hasRootIndex) return res.sendFile(rootIndex);
  res.status(404).send("Missing index.html. Put it in /public/index.html or ./index.html");
});

app.use((err, req, res, next) => {
  const status = err.status || 500;
  res.status(status).json({
    ok: false,
    error: err.message || "Unknown error",
    status,
    hint: status === 400 && String(err.message || "").includes("TIINGO_TOKEN")
      ? "Set TIINGO_TOKEN in Render Environment > Environment Variables."
      : undefined
  });
});

app.listen(PORT, () => {
  console.log(`SMTA Signal Engine running on :${PORT}`);
});
