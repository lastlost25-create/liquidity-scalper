#!/usr/bin/env python3
"""Build a SAMPLE signals.json from the smoke-test data so docs/index.html
renders real engine output. Overwritten by the GitHub Action once a
TWELVEDATA_API_KEY is configured. Clearly labeled as sample."""
import json
import os
import sys

import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "engine"))
from engine import build_payload, track_outcome

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
M1_PATH = os.path.join(BASE, "backtest", "data", "xau_1m.csv")
OUT = os.path.join(BASE, "site", "signals.json")


def load(path):
    df = pd.read_csv(path, parse_dates=["time"])
    df["time"] = pd.to_datetime(df["time"], utc=True)
    return df.set_index("time").sort_index()


def resample(df, rule):
    return df.resample(rule).agg(
        {"open": "first", "high": "max", "low": "min", "close": "last"}
    ).dropna()


m1 = load(M1_PATH)
h1 = resample(m1, "1h")
h4 = resample(m1, "4h")

now = m1.index[-1]
payload = build_payload(m1, h1, h4, now)

# attach forward-tracked outcomes to today's signals (sample only)
for s in payload["signals_today"]:
    after = m1[m1.index > pd.Timestamp(s["signal_at"])]
    if len(after) > 5:
        s.update(track_outcome(s, after))

payload["sample"] = True
payload["sample_note"] = ("SAMPLE — generated from Twelve Data XAU/USD spot 1m history. "
                          "Live engine overwrites this via GitHub Actions once "
                          "TWELVEDATA_API_KEY is set.")
with open(OUT, "w") as f:
    json.dump(payload, f, indent=2)
print(f"wrote {OUT}: verdict={payload['verdict']} signals={len(payload['signals_today'])} "
      f"pools={payload['pool_count']} trend={payload['trend_h1']}")
