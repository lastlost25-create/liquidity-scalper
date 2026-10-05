#!/usr/bin/env python3
"""Live runner used by the GitHub Action (and locally).

Credit-aware fetching for the Twelve Data free tier (800 credits/day):
  * M1 (1500 bars) + H1 (500 bars) every run  -> 2 credits
  * H4 cached to /tmp/h4_cache.csv, re-fetched only if older than 1 hour
At a 5-minute cron this stays near ~600 credits/day (576 + ~24).

XAUUSD liquidity only — no silver (removed 5 Oct 2026: backtest showed the
silver confirmation adds nothing; user decision).

Usage: python3 scripts/run_live.py docs/signals.json
"""
import json
import os
import sys
import time
from datetime import datetime, timezone

import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "engine"))
from engine import build_payload, fetch_twelve

H4_CACHE = "/tmp/h4_cache.csv"
CACHE_TTL = 3600


def cached_fetch(cache_path, interval, outputsize, api_key, symbol="XAU/USD"):
    if os.path.exists(cache_path) and time.time() - os.path.getmtime(cache_path) < CACHE_TTL:
        df = pd.read_csv(cache_path, parse_dates=["time"])
        return df.set_index("time").sort_index()
    df = fetch_twelve(interval, outputsize, api_key, symbol=symbol)
    df.to_csv(cache_path)
    return df


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "docs/signals.json"
    api_key = os.getenv("TWELVEDATA_API_KEY")
    if not api_key:
        raise SystemExit("Set TWELVEDATA_API_KEY (free key from https://twelvedata.com).")
    now = datetime.now(timezone.utc)
    m1 = fetch_twelve("1min", 1500, api_key)
    h1 = fetch_twelve("1h", 500, api_key)
    h4 = cached_fetch(H4_CACHE, "4h", 500, api_key)
    payload = build_payload(m1, h1, h4, now)
    # last 240 closed M1 candles for the on-page chart: [iso, o, h, l, c]
    tail = m1.tail(240)
    payload["candles"] = [
        [t.isoformat(), round(float(r["open"]), 2), round(float(r["high"]), 2),
         round(float(r["low"]), 2), round(float(r["close"]), 2)]
        for t, r in tail.iterrows()
    ]
    with open(out, "w") as f:
        json.dump(payload, f, indent=2)
    print(f"wrote {out}: verdict={payload['verdict']} price={payload['price']:.2f} "
          f"signals={len(payload['signals_today'])} session={payload['session']} "
          f"trend={payload['trend_h1']} candles={len(payload['candles'])}")


if __name__ == "__main__":
    main()
