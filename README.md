# ⚡ Liquidity Scalper — PAXG live (≈ XAUUSD)

A free, 1-page signal dashboard for **pure price-action liquidity-sweep scalping** on gold.
No indicators anywhere — no EMA, RSI, ATR. Only raw candle structure.

**Live page:** https://lastlost25-create.github.io/liquidity-scalper/
(`docs/index.html` + `docs/engine.js` — open `index.html` in any browser)

## How it stays live and free (no server, no API key)

Everything runs **in the visitor's browser**:
- **Feed (primary): Yahoo Finance `XAUUSD=X`** — spot composite that tracks Exness/OANDA
  within ~$1. REST history (1m/1h; 4h resampled client-side) + 20-second polling.
  No key, no account.
- **Feed (automatic fallback): Binance `PAXGUSDT`** public feed
  (`data-api.binance.vision` REST + `data-stream.binance.vision` websocket tick-live).
  Used only if Yahoo blocks the request (it rate-limits some networks); the page
  labels which feed is active. If the websocket is blocked, REST polling every 15s.
- **Engine:** `docs/engine.js` — a JavaScript port of `engine/engine.py`, verified to
  produce **bit-identical signals** (14/14 match on 5 test dates of Twelve Data XAUUSD).
- Weekend: gold market closed Sat/Sun UTC → page shows CLOSED, no signals.

---

## The strategy, in plain English

Big players hunt stop-losses. Stops cluster above old swing highs (buy-side liquidity)
and below old swing lows (sell-side liquidity). When price briefly stabs through one of
those levels and snaps back, the trapped breakout traders fuel a fast move the other way.
This tool waits for exactly that — nothing else.

1. **Find the pools (H4 + H1, closed candles only).** Mark every fractal swing high/low
   (H1: 5 bars each side, H4: 3 bars each side). Swings within **$0.60** of each other merge
   into one pool — equal highs/lows are where the most stops rest (marked ★ premium).
   Keep the last 30 pools per timeframe; pools older than 20 days expire.
2. **Wait for the sweep (M1, closed candles only).** A 1-minute candle's wick must pierce
   a pool by **≥ $0.50** AND close back inside the level.
   - Sweep of a buy-side pool (old high) → **SHORT**
   - Sweep of a sell-side pool (old low) → **LONG**
3. **Build the trade.** Entry = next M1 open. Stop = sweep extreme ± **$0.40** buffer.
   Target = nearest opposing H4/H1 pool. **Require R:R ≥ 1.5** or throw the setup away.
4. **With-trend filter (pure price action, no indicators) — TESTED, REJECTED, OFF by default.**
   The same fractal swings define the H1 structure trend (higher highs + higher lows =
   UPTREND, etc.). We built this at the trader's request ("only trade with the trend"),
   then backtested it on 3 months of data (Jul–Oct 2026, 198 baseline trades): it **cut
   the win rate from 21.2% to 9.6% and flipped expectancy from +0.70R to −0.45R per trade**.
   Why: a liquidity sweep is a stop-hunt — its edge comes from catching the crowd leaning
   the wrong way. Demanding a *confirmed* H1 trend means entering after the move is already
   crowded and exhausted (the 5-bar fractal trend also lags by hours). The filter stays in
   the code as an opt-in research toggle (`USE_TREND_FILTER=1`), but the live engine runs
   without it. True guidance means reporting this even though it contradicts the request.
5. **Silver confirmation — REMOVED (5 Oct 2026, trader's decision).** Silver (XAG/USD)
   was tested as a confirmation gate: it blocked 138 setups without improving the
   survivors (combined with the trend gate: 52 trades, −0.45R expectancy). The engine
   is now XAUUSD liquidity only — no silver code remains in the live path.
6. **Session filter.** Signals only during killzones: **London 07:00–10:00 GMT** and
   **New York 12:00–15:00 GMT** (change via `LONDON_START/LONDON_END/NY_START/NY_END` env vars).
   Max **4 signals/day**, ranked by R:R. One signal per pool per day — no re-entry bleed.
7. **Outside killzones** the dashboard shows WAIT but keeps mapping pools.

Because the engine only ever reads *closed* candles, signals **cannot repaint**.

> **What the data actually says.** The 3-month backtest (88 trading days, 202 trades,
> Twelve Data XAU/USD spot 1m) gives the sweep-only strategy **+0.66R expectancy per
> trade, 20.8% win rate, 1.84 profit factor, ~2.3 signals/day**. New York session carries
> it (28.6% WR, +1.16R); London is weakly positive (+0.26R). The with-trend + silver
> filters were tested and **rejected** (−0.45R expectancy) — see `backtest/RESULTS.md`.
> Expect ~2–3 signals/day and some zero-signal days; a quiet dashboard is the strategy
> working, not broken.

---

## `signals.json` fields (what the dashboard reads)

| Field | Meaning |
|---|---|
| `verdict` | `LONG` / `SHORT` / `WAIT` |
| `wait_reason` | Why WAIT — e.g. "H1 trend is RANGE — 5 sweep(s) blocked, with-trend setups only" |
| `trend_h1` | Gold H1 structure trend: `UPTREND` / `DOWNTREND` / `RANGE` (pure price action) |
| `h4_regime` | Gold H4 structure trend — context only, not a filter |
| `active_signal` | The top setup, incl. `reason` (e.g. "Swept H1 sell-side pool @ 4,189.00 · H1 uptrend"), `trend_h1` |
| `signals_today` | All of today's setups with forward-tracked outcomes |
| `liquidity_map` | Nearest pools above/below price with $ distances |
| `session` / `session_active` | Current killzone state |

## Project layout

```
liquidity-tool/
├── engine/
│   ├── engine.py      # the whole strategy: pools, sweeps, signals, outcomes
│   └── backtest.py    # backtester — imports engine.py, never re-implements it
├── backtest/
│   ├── RESULTS.md     # backtest report: 3-month XAUUSD sweep-only validation
│   └── data/          # XAUUSD M1 CSVs here (e.g. xau_1m.csv)
│                       # columns: time,open,high,low,close (UTC)
├── docs/
│   ├── index.html     # the 1-page dashboard (8 KB, no frameworks, mobile-first)
│   └── signals.json   # engine output, refreshed by the Action / sample for now
├── scripts/
│   ├── run_live.py    # credit-aware live runner (used by the GitHub Action)
│   ├── make_sample.py # builds a sample signals.json from local data
│   └── fetch_yahoo.py # research data fetch (Yahoo, limited — see below)
└── .github/workflows/update.yml  # cron: every 5 min -> engine -> commit -> Pages
```

## Setup (all free)

1. **Get a free Twelve Data API key** — https://twelvedata.com/pricing
   (free plan, no card — lifetime 800 credits/day). It powers the gold feed
   (XAU/USD M1/H1/H4 — about 600 of your 800 daily credits at the default
   5-min refresh, with H4 cached hourly).
2. **Push this folder to a GitHub repo.**
3. **Repo → Settings → Secrets → Actions** → add secret `TWELVEDATA_API_KEY`.
4. **Repo → Settings → Pages** → Source: **GitHub Actions**.
5. Done — every 5 minutes the engine runs, commits a fresh `signals.json`,
   and Pages redeploys the dashboard.

Run the backtest locally once you have data:
```bash
pip install pandas requests
python3 engine/backtest.py backtest/data/your_m1.csv   # columns: time,open,high,low,close (UTC)
```

## Backtest status

`backtest/RESULTS.md` holds the **full 3-month backtest** (Jul–Oct 2026, 88 trading days,
202 trades, Twelve Data XAU/USD spot 1m): **+0.66R expectancy/trade, 20.8% win rate,
1.84 profit factor, ~2.3 signals/day**. New York session is the driver (28.6% WR,
+1.16R); London is weakly positive. The with-trend + silver filter experiment was run
on the same data and **rejected** (−0.45R expectancy) — both gates are off in the live
engine. Re-run anytime: `python3 engine/backtest.py backtest/data/xau_1m.csv`.
**Forward-test on demo 2–4 weeks before risking real money.**

## Honest limitations

- **5-minute refresh latency.** Entries are next-M1-open after a sweep; a 5-min cron can
  show a signal a few minutes late. This is a decision-support screen, not an auto-trader.
- **Some days print zero signals — by design.** A strict filter that stays quiet is the edge.
  Any tool that always finds trades is lying to you.
- **Trend reads need history.** The H1/H4 structure trend only uses confirmed swings, so
  right after a fresh data pull (or a regime flip) it reads RANGE until structure confirms.
  Conservative on purpose. (Trend is display-only; the with-trend gate is OFF unless you
  opt in with `USE_TREND_FILTER=1`.)
- **Free data quirks.** Twelve Data free tier can lag a minute or two at busy times.
- **Sweeps fail.** A sweep is a *reaction* setup, not a prediction. The stop loss is the strategy.
- **Demo first.** Paper-trade any signal for 2–4 weeks before risking real money.

⚠️ Educational use only. Not financial advice. Trading XAUUSD carries substantial risk.
