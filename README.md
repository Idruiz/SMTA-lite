# SMTA Signal Engine (SSE) — actionable plan + benchmark panel

This is a deployable web app you can run **tomorrow** to generate:
- **What to buy / sell**
- **How many shares** (based on your capital + optional holdings)
- **When to rebalance** (weekly or monthly)
- A simple **hold-time estimate**
- A **walk-forward benchmark** panel: **SSE vs SPY**, including a simple slippage model

It uses **EOD (end-of-day) data** from Tiingo on purpose. Intraday “emergent signals” need more data, more latency handling, and more ways to lose money.

---

## 0) What you need

- A Tiingo API token.
- Node 18+ locally (optional).
- On Render: just set `TIINGO_TOKEN`.

---

## 1) Run locally (fast sanity check)

```bash
npm install
TIINGO_TOKEN="YOUR_TOKEN" npm start
```

Open: `http://localhost:3000`

Health endpoint:
- `GET /api/health`

---

## 2) Deploy to Render (GitHub)

1. Create a GitHub repo and push these files.
2. In Render: **New → Web Service → Connect repo**
3. Build command: `npm install`
4. Start command: `npm start`
5. Add Environment Variable:
   - `TIINGO_TOKEN` = your token
6. Deploy. Open the Render URL.

There’s also a `render.yaml` included if you want blueprint-style setup.

---

## 3) Using the UI (step-by-step)

### Step A — Choose universe
- **ETF Rotation (recommended)**: higher signal-to-noise, lower idiosyncratic blowups.
- **Large-cap Stocks**: noisier, but can outperform during strong momentum regimes.
- **Custom**: paste your own tickers.

### Step B — Choose cadence
- **Weekly**: reacts faster, trades more.
- **Monthly**: steadier, typically lower churn.

### Step C — Risk + churn controls
- **No-trade zone**: if a weight change is smaller than this %, the system won’t recommend trading it.
  - Example: 5% means “don’t bother unless the portfolio weight changes meaningfully.”
- **Min holding period**: prevents fast churn (especially useful in chop).

### Step D — Capital + holdings (optional)
- If you paste holdings CSV, trades are computed **vs what you already own**.
- CSV format (headers optional):
  ```
  ticker,shares,avgCost,lastTradeDate
  SPY,10,450,2025-11-10
  QQQ,5,390,2025-11-24
  ```

### Step E — Click “Generate Plan + Benchmark”
Outputs:
1) **Today’s Snapshot**
- As-of date (latest Tiingo EOD)
- Regime (risk_on / caution / risk_off)
- Next rebalance date
- Hold estimate (rough)

2) **Target Allocation**
- Weight, momentum score, realized volatility

3) **Trades**
- BUY/SELL share counts and an explanation (or HOLD if min-hold blocks a sell)

4) **Benchmark Panel**
- Equity curve: **SSE vs SPY**
- Metrics: total return, CAGR, vol, sharpe, max drawdown
- Activity: slippage bps + turnover proxy

### Step F — Download
- **Plan JSON** (full output)
- **Trades CSV** (paste into your broker notes / execute manually)

---

## 4) What the engine actually does (no mysticism)

**Core signals**
- Multi-horizon momentum (1m, 3m, 6m, 12m) + acceleration
- Realized volatility (63-day)
- Simple regime filter using SPY SMA200 and SMA50 (and a “vol spike” caution mode)
- Mild seasonality tilt (tiny weight; capped)

**Allocation**
- Pick **Top N** by score (subject to regime)
- Weight **inverse-vol**
- Scale toward a target portfolio volatility (bounded)

**Churn controls**
- No-trade zone (%)
- Min holding period (days)

**Benchmark**
- Walk-forward rebalance on weekly/monthly schedule
- Slippage cost applied as `bps * turnover`

---

## 5) Important limits (brutal honesty)

- This is **not** “guaranteed to beat SPY.”
- It *can* underperform SPY for long stretches (especially in grind-up bull markets).
- It’s designed to be **actionable**, **testable**, and **not a 12-module fragile mess**.
- The backtest is simplified: adjusted close, no tax, no broker-specific frictions, no leverage.

If you want to go closer to “investment grade,” the next upgrades are:
1) Dividend cashflows & real total-return modeling
2) Better turnover model (asset-level)
3) More robust regime stack (inflation/rates proxies, volatility term structure)
4) Universe-specific constraints (sector caps, max single weight, correlation penalty)

---

## API

- `GET /api/health`
- `POST /api/plan`
  - returns plan + benchmark + trades

---

## Files

- `server.js` — backend (Express)
- `public/index.html` — single-file UI (no external JS deps)
- `render.yaml` — Render setup
