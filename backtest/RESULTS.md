# Liquidity Scalper — Backtest Results

_XAUUSD spot 1m (Twelve Data, free tier): 2026-07-06 → 2026-10-05 (131,639 bars). Live CONFIG, sweep-only, no trend/silver gates._


## Live strategy: pure liquidity sweeps

| Metric | Value |
|---|---|
| Total trades | 202 |
| Win rate (TP / all) | 20.8% |
| Avg R multiple / trade | +0.664 R |
| Expectancy / trade | +0.664 R |
| Profit factor | 1.84 |
| Max drawdown | 33.0 R |
| Expired (neither TP nor SL in 24h) | 0 (0.0%) |
| Avg R:R demanded at entry | 13.71 |
| Trading days in sample | 88 |
| Avg signals / day | 2.30 |
| Days with zero signals | 29 (33.0% — by design, strict filter) |

| Session | Trades | Win rate | Avg R |
|---|---|---|---|
| London | 111 | 14.4% | +0.261 |
| NewYork | 91 | 28.6% | +1.156 |

| Signals | Days |
|---|---|
| 0 | 29 |
| 1 | 6 |
| 2 | 4 |
| 3 | 8 |
| 4 | 41 |

## Historical note — rejected filters

An earlier experiment (5 Oct 2026) added a with-trend gate (H1 structure) plus a silver (XAG/USD H1) confirmation gate. On the identical 73-day window it cut the win rate 21.2% → 9.6% and flipped expectancy +0.70R → −0.45R (52 trades) — both gates were removed from the live engine. The with-trend gate remains as an opt-in research toggle (`USE_TREND_FILTER=1`); silver was removed entirely at the trader's decision.

## Honest caveats

- Gold data: Twelve Data XAU/USD **spot** 1-minute bars (free tier). Your broker's spreads, session quirks and exact fills will differ slightly.
- Same-candle TP+SL ambiguity resolved conservatively (counted as SL).
- Pools and trend state rebuilt daily from prior-day H1/H4 only — no lookahead, slightly conservative.
- Expired trades (24h without TP/SL) counted at exit R; in live trading you'd manage these manually.
- Past performance does not predict future results. Demo-trade first.
