#!/usr/bin/env python3
"""Fetch 1-minute bars from Yahoo Finance (free, no key).

Defaults to GC=F (COMEX gold futures). Pass a symbol + output to fetch
something else:

    python3 scripts/fetch_yahoo.py SI=F backtest/data/si_1m.csv

Two gentle requests covering ~3 months, saved to CSV.
Run rarely — this is a research fetch, not a live feed.
"""
import csv
import os
import sys
import time
from datetime import datetime, timezone

import requests

SYMBOL = sys.argv[1] if len(sys.argv) > 1 else "GC=F"
OUT = (sys.argv[2] if len(sys.argv) > 2
       else os.path.join(os.path.dirname(__file__), "..", "backtest", "data", "gc_1m.csv"))
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"}

WINDOWS = [
    (datetime(2026, 6, 25, tzinfo=timezone.utc), datetime(2026, 8, 24, tzinfo=timezone.utc)),
    (datetime(2026, 8, 5, tzinfo=timezone.utc), datetime(2026, 10, 5, tzinfo=timezone.utc)),
]


def fetch(p1, p2):
    r = requests.get(
        f"https://query1.finance.yahoo.com/v8/finance/chart/{SYMBOL}",
        params={"interval": "1m", "period1": int(p1.timestamp()), "period2": int(p2.timestamp())},
        headers=UA, timeout=60,
    )
    r.raise_for_status()
    res = r.json()["chart"]["result"][0]
    ts, q = res["timestamp"], res["indicators"]["quote"][0]
    rows = []
    for i, t in enumerate(ts):
        if q["open"][i] is None:
            continue
        rows.append((
            datetime.fromtimestamp(t, timezone.utc).isoformat(),
            q["open"][i], q["high"][i], q["low"][i], q["close"][i],
        ))
    return rows


def main():
    all_rows = {}
    for p1, p2 in WINDOWS:
        print(f"fetching {p1.date()} -> {p2.date()} ...")
        for t, o, h, l, c in fetch(p1, p2):
            all_rows[t] = (t, o, h, l, c)
        time.sleep(3)  # be polite
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    rows = [all_rows[k] for k in sorted(all_rows)]
    with open(OUT, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["time", "open", "high", "low", "close"])
        w.writerows(rows)
    print(f"wrote {OUT}: {len(rows)} 1m bars, {rows[0][0]} -> {rows[-1][0]}")


if __name__ == "__main__":
    main()
