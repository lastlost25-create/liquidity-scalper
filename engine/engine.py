#!/usr/bin/env python3
"""
Liquidity Scalper — pure price-action liquidity-sweep signal engine (XAUUSD).

Philosophy: NO indicators. No EMA, RSI, ATR, nothing. Only raw candle
structure: swing highs/lows on H4 and H1 (where resting stop-loss liquidity
sits), and M1 wick sweeps through those levels. Closed candles only —
the engine NEVER looks at a forming candle, so signals cannot repaint.

Pipeline:
    1. Pool detection  — fractal swing highs/lows on closed H4 + H1 candles.
                         Equal highs/lows (within $0.60) merge into premium pools.
    2. Sweep detection — a closed M1 candle's wick pierces a pool by >= $0.50
                         AND the candle closes back inside the level.
                         Sweep of a buy-side pool (high)  -> SHORT
                         Sweep of a sell-side pool (low)  -> LONG
    3. Trade plan      — entry at next M1 open, SL at sweep extreme +/- $0.40
                         buffer, TP at nearest opposing H4/H1 pool.
                         Keep only setups with R:R >= 1.5.
    4. Filters         — London (07:00-10:00 GMT) and NY (12:00-15:00 GMT)
                         killzones only. Optional WITH-TREND gate (OFF by default):
                         H1 structure trend from the same fractal swings
                         (HH+HL = long only, LH+LL = short only, RANGE blocks
                         everything) — pure price action, no indicators.
                         Max 4 signals/day, ranked by R:R. One signal per pool
                         per day.

Output: signals.json consumed by the 1-page dashboard (site/index.html).

Data: Twelve Data free API (needs free key in TWELVEDATA_API_KEY),
      or local CSV files with columns: time,open,high,low,close (UTC).
"""

import json
import math
import os
import sys
from datetime import datetime, timedelta, timezone

import pandas as pd
import requests

# ----------------------------------------------------------------------------
# CONFIG — every rule of the strategy lives here, in plain sight.
# ----------------------------------------------------------------------------
CONFIG = {
    "symbol": "XAUUSD",

    # Pool detection (fractal swings on closed candles)
    "h1_left": 5, "h1_right": 5,          # H1 fractal: 5 bars each side
    "h4_left": 3, "h4_right": 3,          # H4 fractal: 3 bars each side
    "equal_tol": 0.60,                    # equal highs/lows merge within $0.60
    "max_pools_per_tf": 30,               # rolling window of pools per timeframe
    "pool_max_age_days": 20,              # pools expire after 20 days

    # Sweep detection (on closed M1 candles)
    "sweep_pierce": 0.50,                 # wick must pierce pool by >= $0.50
    "sl_buffer": 0.40,                    # SL sits $0.40 beyond the sweep extreme
    "min_rr": 1.5,                        # discard anything under 1.5R
    "max_signals_per_day": 4,             # ranked by R:R, best 4 only

    # Session filter — killzones in GMT (= UTC). Configurable via env:
    #   LONDON_START,LONDON_END,NY_START,NY_END (hours)
    "sessions": [
        ("London", int(os.getenv("LONDON_START", 7)),  int(os.getenv("LONDON_END", 10))),
        ("NewYork", int(os.getenv("NY_START", 12)),   int(os.getenv("NY_END", 15))),
    ],

    # Optional gates — DEFAULT OFF. A 3-month backtest (Jul–Oct 2026, 198
    # baseline trades) showed the with-trend filter DESTROYS the edge:
    # win rate 21.2% -> 9.6%, expectancy +0.70R -> -0.45R. A liquidity sweep
    # is a stop-hunt: it profits from catching the crowd leaning the wrong
    # way, so demanding a confirmed H1 trend means entering after the move
    # is already crowded/exhausted. Kept as a toggle for research, not live.
    "use_trend_filter": os.getenv("USE_TREND_FILTER", "0") == "1",
}

UTC = timezone.utc


# ----------------------------------------------------------------------------
# DATA
# ----------------------------------------------------------------------------
def load_csv(path):
    """Load OHLC CSV: columns time,open,high,low,close (time parsed as UTC)."""
    df = pd.read_csv(path, parse_dates=["time"])
    if df["time"].dt.tz is None:
        df["time"] = df["time"].dt.tz_localize(UTC)
    return df.set_index("time").sort_index()


def fetch_twelve(interval, outputsize, api_key, symbol="XAU/USD"):
    """Fetch OHLC from Twelve Data free tier. interval: 1min/1h/4h."""
    r = requests.get(
        "https://api.twelvedata.com/time_series",
        params={
            "symbol": symbol,
            "interval": interval,
            "outputsize": outputsize,
            "apikey": api_key,
            "timezone": "UTC",
            "order": "ASC",
        },
        timeout=30,
    )
    r.raise_for_status()
    data = r.json()
    if "values" not in data:
        raise RuntimeError(f"Twelve Data error: {data.get('message', data)}")
    df = pd.DataFrame(data["values"])
    df["time"] = pd.to_datetime(df["datetime"], utc=True)
    for c in ("open", "high", "low", "close"):
        df[c] = df[c].astype(float)
    return df.set_index("time")[["open", "high", "low", "close"]].sort_index()


def closed_only(df, now=None):
    """
    Drop any candle that may still be forming. Derives the candle period from
    the median bar spacing and keeps only candles fully closed before `now`.
    """
    now = now or datetime.now(UTC)
    if len(df) < 3:
        return df
    period = df.index.to_series().diff().median()
    cutoff = now - period
    return df[df.index <= cutoff]


# ----------------------------------------------------------------------------
# POOL DETECTION — fractal swing highs/lows on closed H4/H1 candles
# ----------------------------------------------------------------------------
def fractals(df, left, right):
    """Return (swing_highs, swing_lows): lists of (timestamp, price)."""
    highs, lows = [], []
    h, l = df["high"].values, df["low"].values
    idx = df.index
    for i in range(left, len(df) - right):
        window_h = h[i - left : i + right + 1]
        window_l = l[i - left : i + right + 1]
        # Strictly highest high / lowest low of the window (ties -> earliest wins)
        if h[i] == window_h.max() and (window_h == h[i]).argmax() == left:
            highs.append((idx[i], float(h[i])))
        if l[i] == window_l.min() and (window_l == l[i]).argmax() == left:
            lows.append((idx[i], float(l[i])))
    return highs, lows


def detect_pools(h1, h4, cfg=CONFIG, now=None):
    """
    Build the liquidity map: merge fractal swings into pools.
    Equal highs/lows within cfg['equal_tol'] merge into one pool (premium).
    Returns list of pool dicts, newest last.
    """
    now = now or datetime.now(UTC)
    max_age = now - timedelta(days=cfg["pool_max_age_days"])
    pools = []
    pid = 0
    for tf, df, left, right in (
        ("H1", h1, cfg["h1_left"], cfg["h1_right"]),
        ("H4", h4, cfg["h4_left"], cfg["h4_right"]),
    ):
        for side, swings in zip(
            ("high", "low"), fractals(df, left, right)
        ):
            for ts, price in swings:
                if ts < max_age:
                    continue
                # Merge into an existing pool of the same side+tf if within tolerance
                merged = None
                for p in pools:
                    if (
                        p["tf"] == tf
                        and p["side"] == side
                        and abs(p["price"] - price) <= cfg["equal_tol"]
                    ):
                        merged = p
                        break
                if merged:
                    merged["touches"] += 1
                    # pool price = mean of all touches
                    merged["price"] = (
                        merged["price"] * (merged["touches"] - 1) + price
                    ) / merged["touches"]
                    merged["formed_at"] = max(merged["formed_at"], ts)
                else:
                    pid += 1
                    pools.append(
                        {
                            "id": f"{tf}-{side}-{pid}",
                            "tf": tf,
                            "side": side,          # 'high' = buy-side liquidity, 'low' = sell-side
                            "price": round(price, 2),
                            "touches": 1,
                            "premium": False,
                            "formed_at": ts,       # Timestamp internally; isoformat at output
                        }
                    )
    for p in pools:
        p["premium"] = p["touches"] >= 2
    # Rolling window: keep the 30 most recently formed pools per timeframe
    pools.sort(key=lambda p: p["formed_at"])
    kept = []
    for tf in ("H1", "H4"):
        tf_pools = [p for p in pools if p["tf"] == tf]
        kept.extend(tf_pools[-cfg["max_pools_per_tf"] :])
    kept.sort(key=lambda p: p["formed_at"])
    for p in kept:  # serialize timestamps only at the boundary
        p["formed_at"] = pd.Timestamp(p["formed_at"]).isoformat()
        p["price"] = round(p["price"], 2)
    return kept


# ----------------------------------------------------------------------------
# STRUCTURE TREND — pure price action, zero indicators.
# Reuses the fractal swings above: UPTREND = higher highs AND higher lows,
# DOWNTREND = lower highs AND lower lows, anything else (incl. too little
# structure) = RANGE. Shown on the dashboard as context (not a filter).
# ----------------------------------------------------------------------------
def structure_trend(df, left, right):
    """UPTREND / DOWNTREND / RANGE from the last two confirmed fractal swings."""
    highs, lows = fractals(df, left, right)
    if len(highs) < 2 or len(lows) < 2:
        return "RANGE"  # not enough structure to call a trend — no trade
    hp, hc = highs[-2][1], highs[-1][1]
    lp, lc = lows[-2][1], lows[-1][1]
    if hc > hp and lc > lp:
        return "UPTREND"
    if hc < hp and lc < lp:
        return "DOWNTREND"
    return "RANGE"


# ----------------------------------------------------------------------------
# SWEEP DETECTION + TRADE PLANS — on closed M1 candles
# ----------------------------------------------------------------------------
def session_of(ts, cfg=CONFIG):
    """Return killzone name if ts (UTC) falls inside one, else None."""
    hour = ts.hour + ts.minute / 60.0
    for name, start, end in cfg["sessions"]:
        if start <= hour < end:
            return name
    return None


def check_sweep(candle, pool, cfg=CONFIG):
    """
    Did this CLOSED M1 candle sweep the pool?
      buy-side pool (high): wick >= pool + pierce AND close < pool  -> SHORT
      sell-side pool (low):  wick <= pool - pierce AND close > pool  -> LONG
    """
    pierce = cfg["sweep_pierce"]
    if pool["side"] == "high":
        if candle["high"] >= pool["price"] + pierce and candle["close"] < pool["price"]:
            return "SHORT"
    else:
        if candle["low"] <= pool["price"] - pierce and candle["close"] > pool["price"]:
            return "LONG"
    return None


def nearest_opposing_pool(price, pools, direction):
    """Nearest pool on the opposite side of price = take-profit target."""
    cands = (
        [p for p in pools if p["side"] == "low" and p["price"] < price]
        if direction == "SHORT"
        else [p for p in pools if p["side"] == "high" and p["price"] > price]
    )
    if not cands:
        return None
    return max(cands, key=lambda p: p["price"]) if direction == "SHORT" else min(
        cands, key=lambda p: p["price"]
    )


def build_signals(m1, pools, cfg=CONFIG, now=None, date_filter=None,
                gold_h1=None, stats=None):
    """
    Scan the most recent closed M1 candles for sweeps and build trade plans.
    date_filter: optional date — signals are built for one day at a time
    (used by the backtester). Live runs use "today" automatically.
    gold_h1: closed H1 frame used for the optional with-trend filter and for
    recording trend context on each signal (pure price action via
    structure_trend). When a sweep is found, trend is read from H1 candles
    closed BEFORE the sweep candle — zero lookahead, no repaint.
    stats: optional dict collecting blocked_trend / passed counts.
    Returns list of signal dicts, best R:R first.
    """
    now = now or datetime.now(UTC)
    m1 = closed_only(m1, now)
    if len(m1) < 2:
        return []
    if stats is None:
        stats = {}

    signals = []
    used_pools_today = set()  # one signal per pool per day
    if date_filter is not None:
        scan = m1  # backtester passes exactly one day of M1 — scan all of it
    else:
        # live: scan today's bars. (A fixed tail(400) window silently drops
        # the killzones for most of the day — that was a real bug.)
        scan = m1[m1.index.date == now.date()]
    if len(scan) < 2:
        return []

    for i in range(len(scan) - 1):
        sweep_candle = scan.iloc[i]
        ts = scan.index[i]
        day = ts.date()
        if date_filter is not None and day != date_filter:
            continue
        sess = session_of(ts, cfg)
        if sess is None:
            continue  # outside killzones: map pools, print nothing
        for pool in pools:
            if pd.Timestamp(pool["formed_at"]) > ts:
                continue  # pool didn't exist yet at this candle (no lookahead)
            if (pool["id"], day) in used_pools_today:
                continue
            direction = check_sweep(sweep_candle, pool, cfg)
            if not direction:
                continue

            # --- WITH-TREND FILTER (optional, DEFAULT OFF — see CONFIG).
            # H1 structure only, no indicators. When enabled: LONG needs H1
            # UPTREND, SHORT needs H1 DOWNTREND, RANGE blocks all. Trend is
            # always recorded on the signal for the log/dashboard.
            trend = None
            if gold_h1 is not None and len(gold_h1):
                gh = gold_h1[gold_h1.index < ts]  # H1 closed before the sweep
                trend = structure_trend(gh, cfg["h1_left"], cfg["h1_right"])
                if cfg.get("use_trend_filter"):
                    with_trend = (direction == "LONG" and trend == "UPTREND") or (
                        direction == "SHORT" and trend == "DOWNTREND"
                    )
                    if not with_trend:
                        stats["blocked_trend"] = stats.get("blocked_trend", 0) + 1
                        continue

            # --- SILVER CONFIRMATION removed (5 Oct 2026, user decision):
            # backtest showed it adds nothing (blocked 138 setups, survivors
            # still -0.45R expectancy). Engine is XAUUSD liquidity only.
            stats["passed"] = stats.get("passed", 0) + 1

            entry = float(scan.iloc[i + 1]["open"])  # next M1 open
            extreme = float(sweep_candle["high"] if direction == "SHORT" else sweep_candle["low"])
            buf = cfg["sl_buffer"]
            sl = extreme + buf if direction == "SHORT" else extreme - buf
            tp_pool = nearest_opposing_pool(entry, pools, direction)
            if tp_pool is None:
                continue  # no opposing liquidity to target — no trade
            tp = tp_pool["price"]
            risk = abs(entry - sl)
            reward = abs(tp - entry)
            if risk <= 0:
                continue
            rr = reward / risk
            if rr < cfg["min_rr"]:
                continue

            reason_bits = [
                f"Swept {pool['tf']} {'buy' if pool['side']=='high' else 'sell'}-side "
                f"pool @ {pool['price']:,.2f}"
                + (" (equal highs/lows)" if pool["premium"] else "")
            ]
            if trend:
                reason_bits.append(f"H1 {trend.lower()}")
            signals.append(
                {
                    "direction": direction,
                    "entry": round(entry, 2),
                    "sl": round(sl, 2),
                    "tp": round(tp, 2),
                    "rr": round(rr, 2),
                    "pool_id": pool["id"],
                    "pool_tf": pool["tf"],
                    "pool_side": pool["side"],
                    "pool_price": pool["price"],
                    "trend_h1": trend,
                    "swept_at": ts.isoformat(),
                    "signal_at": scan.index[i + 1].isoformat(),  # entry candle open
                    "session": sess,
                    "reason": " · ".join(reason_bits),
                }
            )
            used_pools_today.add((pool["id"], day))

    signals.sort(key=lambda s: s["rr"], reverse=True)
    return signals[: cfg["max_signals_per_day"]]


# ----------------------------------------------------------------------------
# OUTCOME TRACKING — forward-walk M1 after entry: TP or SL first?
# ----------------------------------------------------------------------------
def track_outcome(signal, m1_after, max_hold_hours=24):
    """
    Walk forward through M1 candles after entry. First touch wins.
    If TP and SL both print inside one candle we assume SL hit first
    (conservative; documented in README).
    """
    entry, sl, tp = signal["entry"], signal["sl"], signal["tp"]
    direction = signal["direction"]
    deadline = pd.Timestamp(signal["signal_at"]) + timedelta(hours=max_hold_hours)
    for ts, c in m1_after.iterrows():
        if ts > deadline:
            break
        hi, lo = float(c["high"]), float(c["low"])
        if direction == "LONG":
            sl_hit = lo <= sl
            tp_hit = hi >= tp
        else:
            sl_hit = hi >= sl
            tp_hit = lo <= tp
        if sl_hit or tp_hit:
            won = tp_hit and not sl_hit
            # both hit in one candle -> conservative: SL first
            r = signal["rr"] if won else -1.0
            return {
                "outcome": "TP" if won else "SL",
                "r": round(r, 2),
                "closed_at": ts.isoformat(),
            }
    # Expired: mark at last available close
    last = m1_after.iloc[-1]
    exit_px = float(last["close"])
    r = (exit_px - entry) / abs(entry - sl) if direction == "LONG" else (entry - exit_px) / abs(entry - sl)
    return {"outcome": "EXPIRED", "r": round(r, 2), "closed_at": m1_after.index[-1].isoformat()}


# ----------------------------------------------------------------------------
# LIVE RUN — fetch, compute, write signals.json
# ----------------------------------------------------------------------------
def liquidity_map(price, pools, n=5):
    above = sorted([p for p in pools if p["price"] >= price], key=lambda p: p["price"])[:n]
    below = sorted([p for p in pools if p["price"] < price], key=lambda p: p["price"], reverse=True)[:n]
    def row(p):
        return {
            "id": p["id"], "tf": p["tf"], "side": p["side"],
            "price": p["price"], "touches": p["touches"],
            "premium": p["premium"], "distance": round(abs(p["price"] - price), 2),
        }
    return {"above": [row(p) for p in above], "below": [row(p) for p in below]}


def build_payload(m1, h1, h4, now=None):
    """Core pipeline: closed candles -> pools -> signals -> dashboard payload."""
    now = now or datetime.now(UTC)
    m1c, h1c, h4c = closed_only(m1, now), closed_only(h1, now), closed_only(h4, now)
    pools = detect_pools(h1c, h4c, now=now)
    cfg_trend_on = CONFIG.get("use_trend_filter", False)
    stats = {}
    signals = build_signals(m1c, pools, now=now, gold_h1=h1c, stats=stats)
    # Live recency: a sweep setup is only actionable shortly after it prints.
    # The verdict / active card follow fresh signals (<=120 min old); the full
    # day's log stays visible in signals_today.
    fresh_cutoff = now - timedelta(minutes=120)
    fresh = [s for s in signals
             if datetime.fromisoformat(s["signal_at"]) >= fresh_cutoff]
    price = float(m1c.iloc[-1]["close"])
    sess = session_of(now)

    trend_h1 = structure_trend(h1c, CONFIG["h1_left"], CONFIG["h1_right"])
    h4_regime = structure_trend(h4c, CONFIG["h4_left"], CONFIG["h4_right"])

    wait_reason = None
    if not fresh:
        n_trend = stats.get("blocked_trend", 0)
        if sess is None:
            wait_reason = "Outside killzones — pools still mapped, no signals"
        elif n_trend > 0:
            wait_reason = (f"H1 trend is {trend_h1} — {n_trend} sweep(s) blocked, "
                           "with-trend setups only")
        elif cfg_trend_on and trend_h1 == "RANGE":
            wait_reason = "H1 trend is RANGE — with-trend setups only, waiting for structure"
        else:
            wait_reason = "In killzone — waiting for a pool sweep…"

    return {
        "engine": "liquidity-scalper",
        "symbol": CONFIG["symbol"],
        "updated_at": now.isoformat(),
        "price": round(price, 2),
        "session": sess or "OFF",
        "session_active": sess is not None,
        "trend_h1": trend_h1,      # UPTREND / DOWNTREND / RANGE (pure price action)
        "h4_regime": h4_regime,     # context only — not a hard filter
        "verdict": fresh[0]["direction"] if fresh else "WAIT",
        "wait_reason": wait_reason,
        "active_signal": fresh[0] if fresh else None,
        "signals_today": signals,
        "liquidity_map": liquidity_map(price, pools),
        "pool_count": len(pools),
        "disclaimer": "Educational use only. Not financial advice. Trade on demo first.",
    }


def run_live(out_path, api_key=None, h1_csv=None, h4_csv=None, m1_csv=None):
    now = datetime.now(UTC)
    if api_key:
        m1 = fetch_twelve("1min", 1500, api_key)
        h1 = fetch_twelve("1h", 500, api_key)
        h4 = fetch_twelve("4h", 500, api_key)
    else:
        if not (m1_csv and h1_csv and h4_csv):
            raise SystemExit("Need TWELVEDATA_API_KEY or three CSVs (m1,h1,h4).")
        m1, h1, h4 = load_csv(m1_csv), load_csv(h1_csv), load_csv(h4_csv)

    payload = build_payload(m1, h1, h4, now)
    with open(out_path, "w") as f:
        json.dump(payload, f, indent=2)
    print(f"wrote {out_path}: verdict={payload['verdict']} price={payload['price']:.2f} "
          f"signals={len(payload['signals_today'])} session={payload['session']}")
    return payload


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "signals.json"
    key = os.getenv("TWELVEDATA_API_KEY")
    csvs = {k: os.getenv(v) for k, v in
            (("m1_csv", "M1_CSV"), ("h1_csv", "H1_CSV"), ("h4_csv", "H4_CSV"))}
    run_live(out, api_key=key or None, **{k: v for k, v in csvs.items() if v})
