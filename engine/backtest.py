#!/usr/bin/env python3
"""
Liquidity Scalper — backtester.

Runs the EXACT same rules as engine.py (imported, not copied) over historical
XAUUSD M1 data:

  * Pools are rebuilt once per day using only H1/H4 candles closed BEFORE
    that day starts  -> zero lookahead. (Slightly conservative: pools that
    form intraday are picked up the next day.)
  * Signals: build_signals() with the live CONFIG (sweep, killzone session
    filter, RR >= 1.5, max 4/day, one signal per pool per day).
  * Outcomes: track_outcome() forward-walks M1 after entry.

DATA (free): Twelve Data XAU/USD spot 1-minute bars, pulled by
~/workspace/skills/twelvedata/bin/fetch_bars.py
(e.g. backtest/data/xau_1m.csv). XAUUSD only — no silver (removed 5 Oct 2026:
backtest showed the silver confirmation adds nothing; user decision).

Usage:
    python3 backtest.py [gold_m1_csv]

Output: backtest/RESULTS.md + console table.
"""

import os
import sys
from datetime import timedelta

import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "engine"))
from engine import CONFIG, build_signals, detect_pools, track_outcome

DATA = os.path.join(os.path.dirname(__file__), "..", "backtest", "data", "xau_1m.csv")


def load_m1(path):
    df = pd.read_csv(path, parse_dates=["time"])
    if df["time"].dt.tz is None:
        df["time"] = df["time"].dt.tz_localize("UTC")
    df = df.set_index("time").sort_index()
    return df[~df.index.duplicated(keep="last")]


def resample(df, rule):
    agg = {"open": "first", "high": "max", "low": "min", "close": "last"}
    out = df.resample(rule).agg(agg).dropna()
    return out


def run(m1, cfg=None):
    cfg = cfg or CONFIG
    h1 = resample(m1, "1h")
    h4 = resample(m1, "4h")
    all_sigs = []
    days = sorted(set(m1.index.date))
    day_stats = {}
    filter_stats = {"blocked_trend": 0, "passed": 0}
    skipped_days = 0

    for d in days:
        day_start = pd.Timestamp(d, tz="UTC")
        # Pools + trend state from H1/H4 closed strictly before this day (no lookahead)
        h1_hist = h1[h1.index < day_start]
        h4_hist = h4[h4.index < day_start]
        if len(h1_hist) < 50 or len(h4_hist) < 20:
            skipped_days += 1
            continue
        pools = detect_pools(h1_hist, h4_hist, now=day_start)
        day_m1 = m1[(m1.index >= day_start) & (m1.index < day_start + timedelta(days=1))]
        if len(day_m1) < 60:
            skipped_days += 1
            continue
        stats = {}
        sigs = build_signals(
            day_m1, pools, cfg=cfg, now=day_start + timedelta(days=1), date_filter=d,
            gold_h1=h1_hist, stats=stats,
        )
        for k in filter_stats:
            filter_stats[k] += stats.get(k, 0)
        day_stats[d] = len(sigs)
        for s in sigs:
            after = m1[m1.index > pd.Timestamp(s["signal_at"])]
            if len(after) < 5:
                continue
            oc = track_outcome(s, after)
            all_sigs.append({**s, **oc})
    return all_sigs, day_stats, filter_stats, skipped_days


def summarize(sigs, day_stats, filter_stats, skipped_days):
    """Headline metrics for the run."""
    df = pd.DataFrame(sigs)
    out = {"trades": len(df), "days": len(day_stats), "skipped_days": skipped_days,
           "blocked_trend": filter_stats.get("blocked_trend", 0),
           "sig_per_day": 0, "zero_days": len(day_stats)}
    if len(df) == 0:
        return out
    wins = df[df["outcome"] == "TP"]
    losses = df[df["outcome"] == "SL"]
    expired = df[df["outcome"] == "EXPIRED"]
    gross_win = wins["r"].sum()
    gross_loss = -losses["r"].sum()
    cum = df["r"].cumsum()
    out.update({
        "win_rate": len(wins) / len(df),
        "avg_r": df["r"].mean(),
        "profit_factor": gross_win / gross_loss if gross_loss > 0 else float("inf"),
        "max_dd": (cum.cummax() - cum).max(),
        "expired": len(expired),
        "avg_rr": df["rr"].mean(),
        "sig_per_day": len(df) / len(day_stats) if day_stats else 0,
        "zero_days": sum(1 for v in day_stats.values() if v == 0),
    })
    out["sess"] = df.groupby("session").agg(
        trades=("r", "size"),
        winrate=("outcome", lambda x: (x == "TP").mean()),
        avg_r=("r", "mean"),
    )
    out["dist"] = pd.Series(list(day_stats.values())).value_counts().sort_index()
    return out


def table(title, s):
    lines = [f"\n## {title}\n"]
    if s["trades"] == 0:
        lines.append("No signals printed in this window (possible on quiet data).")
        return "\n".join(lines)
    lines.append("| Metric | Value |")
    lines.append("|---|---|")

    def row(k, v):
        lines.append(f"| {k} | {v} |")

    row("Total trades", s["trades"])
    row("Win rate (TP / all)", f"{s['win_rate']:.1%}")
    row("Avg R multiple / trade", f"{s['avg_r']:+.3f} R")
    row("Expectancy / trade", f"{s['avg_r']:+.3f} R")
    pf = s["profit_factor"]
    row("Profit factor", f"{pf:.2f}" if pf != float("inf") else "∞ (no losing trades)")
    row("Max drawdown", f"{s['max_dd']:.1f} R")
    row("Expired (neither TP nor SL in 24h)", f"{s['expired']} ({s['expired']/s['trades']:.1%})")
    row("Avg R:R demanded at entry", f"{s['avg_rr']:.2f}")
    row("Trading days in sample", s["days"])
    row("Avg signals / day", f"{s['sig_per_day']:.2f}")
    row("Days with zero signals",
        f"{s['zero_days']} ({s['zero_days']/s['days']:.1%} — by design, strict filter)")
    lines.append("\n| Session | Trades | Win rate | Avg R |")
    lines.append("|---|---|---|---|")
    for name, r in s["sess"].iterrows():
        lines.append(f"| {name} | {int(r['trades'])} | {r['winrate']:.1%} | {r['avg_r']:+.3f} |")
    lines.append("\n| Signals | Days |")
    lines.append("|---|---|")
    for k, v in s["dist"].items():
        lines.append(f"| {k} | {v} |")
    return "\n".join(lines)


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else DATA
    if not os.path.exists(path):
        sys.exit(f"No data at {path}. Fetch it first — see README.")
    print(f"Loading gold {path} ...")
    m1 = load_m1(path)
    print(f"M1 bars: {len(m1)}  from {m1.index[0]} to {m1.index[-1]}")

    print("\n— backtest: live strategy (sweep-only, XAUUSD) —")
    sigs, day_stats, filter_stats, skipped = run(m1, cfg=dict(CONFIG))
    s = summarize(sigs, day_stats, filter_stats, skipped)

    md = ["# Liquidity Scalper — Backtest Results\n"]
    md.append(f"_XAUUSD spot 1m (Twelve Data, free tier): "
              f"{m1.index[0].date()} → {m1.index[-1].date()} ({len(m1):,} bars). "
              f"Live CONFIG, sweep-only, no trend/silver gates._\n")
    md.append(table("Live strategy: pure liquidity sweeps", s))
    md.append("\n## Historical note — rejected filters\n")
    md.append("An earlier experiment (5 Oct 2026) added a with-trend gate (H1 structure) "
              "plus a silver (XAG/USD H1) confirmation gate. On the identical 73-day window "
              "it cut the win rate 21.2% → 9.6% and flipped expectancy +0.70R → −0.45R "
              "(52 trades) — both gates were removed from the live engine. The with-trend "
              "gate remains as an opt-in research toggle (`USE_TREND_FILTER=1`); silver was "
              "removed entirely at the trader's decision.")
    md.append("\n## Honest caveats\n")
    md.append("- Gold data: Twelve Data XAU/USD **spot** 1-minute bars (free tier). "
              "Your broker's spreads, session quirks and exact fills will differ slightly.")
    md.append("- Same-candle TP+SL ambiguity resolved conservatively (counted as SL).")
    md.append("- Pools and trend state rebuilt daily from prior-day H1/H4 only — no lookahead, "
              "slightly conservative.")
    md.append("- Expired trades (24h without TP/SL) counted at exit R; in live trading you'd "
              "manage these manually.")
    md.append("- Past performance does not predict future results. Demo-trade first.")
    report = "\n".join(md)

    out = os.path.join(os.path.dirname(__file__), "..", "backtest", "RESULTS.md")
    with open(out, "w") as f:
        f.write(report + "\n")
    print("\n" + report)
    print(f"\nWrote {out}")


if __name__ == "__main__":
    main()
