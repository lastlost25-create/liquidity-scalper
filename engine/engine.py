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
    "d1_left": 2, "d1_right": 2,          # D1 fractal: 2 bars each side (DQRS-style daily levels)
    "equal_tol": 0.60,                    # equal highs/lows merge within $0.60
    "max_pools_per_tf": 30,               # rolling window of pools per timeframe
    "pool_max_age_days": 20,              # pools expire after 20 days

    # Sweep detection (on closed M1 candles)
    "sweep_pierce": 0.50,                 # wick must pierce pool by >= $0.50
    "sl_buffer": 0.40,                    # SL sits $0.40 beyond the sweep extreme
    "min_rr": 2.5,                        # discard anything under 2.5R (raised 5 Oct 2026: backtest +0.664R -> +0.812R/trade; stops weak early sweeps claiming a pool before the good one)
    "max_signals_per_day": 4,             # ranked by R:R, best 4 only

    # Session filter — killzones in GMT (= UTC). Configurable via env:
    #   LONDON_START,LONDON_END,NY_START,NY_END (hours)
    "sessions": [
        ("London", int(os.getenv("LONDON_START", 6)),  int(os.getenv("LONDON_END", 10))),
        ("NewYork", int(os.getenv("NY_START", 12)),   int(os.getenv("NY_END", 15))),
    ],

    # Optional gates — DEFAULT OFF. A 3-month backtest (Jul–Oct 2026, 198
    # baseline trades) showed the with-trend filter DESTROYS the edge:
    # win rate 21.2% -> 9.6%, expectancy +0.70R -> -0.45R. A liquidity sweep
    # is a stop-hunt: it profits from catching the crowd leaning the wrong
    # way, so demanding a confirmed H1 trend means entering after the move
    # is already crowded/exhausted. Kept as a toggle for research, not live.
    "use_trend_filter": os.getenv("USE_TREND_FILTER", "0") == "1",

    # Swing setup ("liq bias"): 15m major swings + M1 sweep + confirmation
    "m15_left": 5, "m15_right": 5,          # 15m fractal for major swings
    "confirm_body_ratio": 0.6,              # "good body": body >= 60% of candle range
    "max_swing_signals_per_day": 4,         # separate daily cap for swing setups
    "swing_sl_buffer": 1.00,                # swing stops sit $1 beyond the extreme (Mickey: 8-10 pip SL, corrected 5 Oct 2026)
    "swing_v2_sl": 2.50,                   # v2 sniper SL: fixed $2.50 from entry (his real $2.16, 6 Oct 2026)
    "swing_v2_pool_once": False,          # re-sweeps of the same pool may fire (backtest 6 Oct 2026: +3.94R vs +3.16R)
    "swing_v2_min_risk": 0.0,             # min $ risk per signal; 0 = off (filters noise-tight stops)
    "swing_v2_rank": "rr",                # final daily pick: "rr" (top-RR first) or "time" (chronological)
    "swing_v2_pd_filter": False,        # StockLearners 6 Oct 2026: premium/discount filter —
                                       # SHORT only above the day-range 50% (premium),
                                       # LONG only below it (discount). Backtest before enabling.
    "htf_match_tol": 1.00,                  # 15m swing must sit within $1 of an H1/H4 fractal level (Mickey: HTF confluence)
    "disp_min": 0,                          # displacement-origin filter OFF by default; set to $ to require
    "disp_bars": 8,                         # forward 15m bars over which displacement is measured
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
            # One signal per LEVEL per day: an H1 pool and an H4 pool sitting
            # at the same price are one level — a sweep that fires one must
            # not print the other as a second signal (Oct 6 duplicate fix).
            for p2 in pools:
                if (p2["side"] == pool["side"]
                        and abs(p2["price"] - pool["price"]) <= cfg["equal_tol"]):
                    used_pools_today.add((p2["id"], day))

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
    # Expired only if the deadline actually passed inside the data.
    # A trade that hasn't hit TP/SL with time left is OPEN (None), not expired.
    if len(m1_after) == 0 or m1_after.index[-1] <= deadline:
        return {"outcome": None, "r": None}
    window = m1_after[m1_after.index <= deadline]
    if len(window):
        exit_ts, exit_px = window.index[-1], float(window.iloc[-1]["close"])
    else:
        exit_ts, exit_px = m1_after.index[0], float(m1_after.iloc[0]["close"])
    r = (exit_px - entry) / abs(entry - sl) if direction == "LONG" else (entry - exit_px) / abs(entry - sl)
    return {"outcome": "EXPIRED", "r": round(r, 2), "closed_at": exit_ts.isoformat()}


# ----------------------------------------------------------------------------
# SWING SETUP ("liq bias") — 15m major swings, M1 sweep, confirmation candles
#
# SHORT: price stretches into a 15m swing high and sweeps it on M1
#        -> 2 red M1 candles -> 1 red candle closing below the low of a
#        strong-bodied red candle ("good body" >= 60% of range)
#        -> short at next M1 open, SL above swing extreme + buffer,
#           TP1/TP2/TP3 = last three 15m swing lows.
# LONG: mirrored at 15m swing lows. Closed candles only — no repaint.
# Exact port of docs/engine.js (detect_swings / build_swing_signals /
# track_swing_outcome).
# ----------------------------------------------------------------------------
def htf_liquidity_levels(h1, h4, d1=None, cfg=CONFIG):
    """
    Raw H1/H4/D1 fractal swing prices, by side, for HTF confluence matching.
    A 15m swing only qualifies as "major" if it sits within htf_match_tol
    of one of these levels (same side). d1 = daily bars (DQRS-style levels);
    pass h1=None, h4=None for daily-only matching.
    """
    lv = {"high": [], "low": []}
    for df, left, right in (
        (h1, cfg["h1_left"], cfg["h1_right"]),
        (h4, cfg["h4_left"], cfg["h4_right"]),
        (d1, cfg["d1_left"], cfg["d1_right"]),
    ):
        if df is None or len(df) == 0:
            continue
        for side, arr in zip(("high", "low"), fractals(df, left, right)):
            lv[side].extend(float(p) for _, p in arr)
    return lv


def detect_swings(m15, cfg=CONFIG, now=None, htf_levels=None):
    """
    15m major swings for the "liq bias" swing setup. Mirrors detect_pools but
    single timeframe ('M15'): fractal swing highs/lows merged within
    cfg['equal_tol'] (premium on 2+ touches), cfg['pool_max_age_days'] max age,
    rolling cfg['max_pools_per_tf'] most recent. Ids like 'M15-high-3'.
    htf_levels (optional): {'high': [...], 'low': [...]} from
    htf_liquidity_levels — when given, only swings sitting within
    cfg['htf_match_tol'] of a same-side H1/H4 level are kept (Mickey's
    HTF-confluence rule: only trade major 15m swings that also hold
    1H/4H liquidity).
    Returns list of swing dicts, newest last; formed_at serialized to isoformat.
    """
    now = now or datetime.now(UTC)
    max_age = now - timedelta(days=cfg["pool_max_age_days"])
    swings = []
    pid = 0
    for side, arr in zip(("high", "low"), fractals(m15, cfg["m15_left"], cfg["m15_right"])):
        for ts, price in arr:
            if ts < max_age:
                continue
            # Displacement-origin filter (video concept: "liquidity rehta hai
            # jis jagah se bar gira") — a swing only counts as real liquidity
            # if price displaced strongly away from the pivot shortly after
            # it printed. Highs must have dropped disp_min, lows rallied it,
            # within disp_bars 15m bars.
            if cfg.get("disp_min"):
                try:
                    j = m15.index.get_loc(ts)
                except KeyError:
                    continue
                fwd = m15.iloc[j + 1 : j + 1 + cfg["disp_bars"]]
                if len(fwd) == 0:
                    continue
                if side == "high":
                    excursion = price - float(fwd["low"].min())
                else:
                    excursion = float(fwd["high"].max()) - price
                if excursion < cfg["disp_min"]:
                    continue
            merged = None
            for p in swings:
                if p["side"] == side and abs(p["price"] - price) <= cfg["equal_tol"]:
                    merged = p
                    break
            if merged:
                merged["touches"] += 1
                # swing price = mean of all touches
                merged["price"] = (
                    merged["price"] * (merged["touches"] - 1) + price
                ) / merged["touches"]
                merged["formed_at"] = max(merged["formed_at"], ts)
            else:
                pid += 1
                swings.append(
                    {
                        "id": f"M15-{side}-{pid}",
                        "tf": "M15",
                        "side": side,          # 'high' = buy-side, 'low' = sell-side
                        "price": round(price, 2),
                        "touches": 1,
                        "premium": False,
                        "formed_at": ts,       # Timestamp internally; isoformat at output
                    }
                )
    for p in swings:
        p["premium"] = p["touches"] >= 2
    if htf_levels is not None:
        tol = cfg["htf_match_tol"]
        swings = [
            p for p in swings
            if any(abs(p["price"] - lvl) <= tol for lvl in htf_levels.get(p["side"], []))
        ]
    swings.sort(key=lambda p: p["formed_at"])
    kept = swings[-cfg["max_pools_per_tf"] :]
    for p in kept:  # serialize timestamps only at the boundary
        p["formed_at"] = pd.Timestamp(p["formed_at"]).isoformat()
        p["price"] = round(p["price"], 2)
    return kept


def build_swing_signals(m1, swings, cfg=CONFIG, now=None, date_filter=None):
    """
    Scan one day of closed M1 bars for 15m-swing sweeps with confirmation.
    Exact port of docs/engine.js build_swing_signals (DataFrame-based).

    Per sweep candle: (1) two confirmation candles of the reversal color right
    after the sweep, (2) a "good body" reference = strongest-bodied
    right-colored candle in i+1..i+4 with body/range >= confirm_body_ratio,
    (3) a break candle = first right-colored candle in i+3..i+8 closing beyond
    the reference extreme, (4) no confirmation candle (i+1..brk) closed back
    beyond the swing level (reclaimed sweep -> skip). Entry at the next M1
    open (must be in a killzone), SL at max/min(swing price, sweep extreme)
    +/- sl_buffer, TP1/TP2/TP3 = the three most recent opposing 15m swings,
    R:R on TP1 >= min_rr gate, and entry must sit strictly between SL and
    TP1 (never already through the stop).

    date_filter: optional date — signals are built for one day at a time.
    Live runs use "today" automatically. Caller passes closed M1 bars.
    Returns (signals, stats); signals ranked by R:R, capped at
    max_swing_signals_per_day. One signal per swing id per day.
    """
    now = now or datetime.now(UTC)
    if date_filter is not None:
        scan = m1  # caller passes exactly one day of M1
    else:
        scan = m1[m1.index.date == now.date()]
    if len(scan) < 10:
        return [], {}
    stats = {}
    used = set()  # one signal per swing id per day
    signals = []

    def is_red(k):
        return float(k["close"]) < float(k["open"])

    def is_green(k):
        return float(k["close"]) > float(k["open"])

    def body_ratio(k):
        h, l = float(k["high"]), float(k["low"])
        if h == l:
            return 0.0
        return abs(float(k["close"]) - float(k["open"])) / (h - l)

    n = len(scan)
    for i in range(n - 9):
        sweep = scan.iloc[i]
        ts = scan.index[i]
        for sw in swings:
            if pd.Timestamp(sw["formed_at"]) > ts:
                continue  # swing didn't exist yet at this candle (no lookahead)
            if sw["id"] in used:
                continue  # one signal per swing id per day
            direction = check_sweep(sweep, sw, cfg)
            if not direction:
                continue
            red = direction == "SHORT"

            # 1) two confirmation candles of the right color right after the sweep
            c1, c2 = scan.iloc[i + 1], scan.iloc[i + 2]
            two_ok = (is_red(c1) and is_red(c2)) if red else (is_green(c1) and is_green(c2))
            if not two_ok:
                stats["no_confirm"] = stats.get("no_confirm", 0) + 1
                continue

            # 2) "good body" reference: strongest-bodied right-colored candle in i+1..i+4
            ref = None
            ref_body = -1.0
            for j in range(i + 1, i + 5):
                k = scan.iloc[j]
                if ((is_red(k) if red else is_green(k))
                        and body_ratio(k) >= cfg["confirm_body_ratio"]):
                    b = abs(float(k["close"]) - float(k["open"]))
                    if b > ref_body:
                        ref_body = b
                        ref = k
            if ref is None:
                stats["no_ref"] = stats.get("no_ref", 0) + 1
                continue
            ref_low, ref_high = float(ref["low"]), float(ref["high"])

            # 3) break candle: first right-colored candle in i+3..i+8 closing beyond ref extreme
            brk = -1
            for j in range(i + 3, i + 9):
                k = scan.iloc[j]
                broke = (is_red(k) and float(k["close"]) < ref_low) if red \
                    else (is_green(k) and float(k["close"]) > ref_high)
                if broke:
                    brk = j
                    break
            if brk < 0:
                stats["no_break"] = stats.get("no_break", 0) + 1
                continue

            # the sweep stands only if no confirmation candle closed back
            # beyond the level
            sw_price = float(sw["price"])
            reclaimed = False
            for j in range(i + 1, brk + 1):
                cj = float(scan.iloc[j]["close"])
                if (cj > sw_price) if red else (cj < sw_price):
                    reclaimed = True
                    break
            if reclaimed:
                stats["reclaimed"] = stats.get("reclaimed", 0) + 1
                continue

            entry_bar = scan.iloc[brk + 1]              # entry at next M1 open
            entry = float(entry_bar["open"])
            entry_ts = scan.index[brk + 1]
            sess = session_of(entry_ts, cfg)
            if not sess:
                stats["off_session"] = stats.get("off_session", 0) + 1
                continue

            if red:
                extreme = max(sw_price, float(sweep["high"]))
                sl = extreme + cfg["swing_sl_buffer"]
            else:
                extreme = min(sw_price, float(sweep["low"]))
                sl = extreme - cfg["swing_sl_buffer"]

            # TP1/TP2/TP3: the three most recent opposing 15m swings
            opp = [
                s for s in swings
                if pd.Timestamp(s["formed_at"]) < entry_ts
                and (s["side"] == "low" and float(s["price"]) < entry
                     if red else s["side"] == "high" and float(s["price"]) > entry)
            ]
            opp.sort(key=lambda s: float(s["price"]), reverse=red)
            opp = opp[:3]
            if not opp:
                stats["no_tp"] = stats.get("no_tp", 0) + 1
                continue
            tp1 = float(opp[0]["price"])
            tp2 = float(opp[1]["price"]) if len(opp) > 1 else None
            tp3 = float(opp[2]["price"]) if len(opp) > 2 else None
            risk = abs(entry - sl)
            if risk <= 0:
                continue
            if risk < cfg.get("swing_v2_min_risk", 0.0):
                stats["tiny_risk"] = stats.get("tiny_risk", 0) + 1
                continue
            rr1 = abs(tp1 - entry) / risk
            if rr1 < cfg["min_rr"]:
                stats["low_rr"] = stats.get("low_rr", 0) + 1
                continue
            # sanity: entry must sit between SL and TP1 (never already through the stop)
            sides_ok = (entry < sl and entry > tp1) if red else (entry > sl and entry < tp1)
            if not sides_ok:
                stats["invalid"] = stats.get("invalid", 0) + 1
                continue

            def rr_of(v):
                return None if v is None else round(abs(v - entry) / risk, 2)

            signals.append(
                {
                    "kind": "swing",
                    "direction": direction,
                    "entry": round(entry, 2),
                    "sl": round(sl, 2),
                    "tp": tp1,
                    "tp2": tp2,
                    "tp3": tp3,
                    "rr": round(rr1, 2),
                    "rr2": rr_of(tp2),
                    "rr3": rr_of(tp3),
                    "swing_id": sw["id"],
                    "swing_tf": "M15",
                    "swing_price": sw_price,
                    "swept_at": ts.isoformat(),
                    "confirm_at": scan.index[brk].isoformat(),
                    "signal_at": entry_ts.isoformat(),
                    "session": sess,
                    "reason": (
                        f"Swept M15 {'buy' if sw['side'] == 'high' else 'sell'}-side "
                        f"swing @ {sw_price:,.2f}"
                        + (" ★" if sw["premium"] else "")
                        + " · 2-candle + break confirmation"
                    ),
                }
            )
            used.add(sw["id"])
            stats["passed"] = stats.get("passed", 0) + 1

    signals.sort(key=lambda s: s["rr"], reverse=True)
    return signals[: cfg["max_swing_signals_per_day"]], stats


def build_swing_signals_v2(m1, pools, cfg=CONFIG, now=None, date_filter=None,
                           pdl=None, pdh=None, sl_mode="fixed"):
    """
    Screenshot-faithful "sniper" swing setup, calibrated 6 Oct 2026 from
    Mickey's real OANDA trade (Oct 6 2026: LONG 4114.911, SL 4112.755,
    TP1 4123.335 = PDL, TP2 ~4131.5, TP3 ~4139.5, Final 4152.237).

    Level: the H1/H4 pool itself (his "4h + 1h swing low") — no 15m middleman.
    Trigger: M1 sweep (wick >= pool +/- sweep_pierce, close back inside).
    Entry: next M1 open (the reclaim). No confirmation / break candles.
    SL: sl_mode="fixed" -> entry -/+ cfg["swing_v2_sl"] ($2.50 ~ his $2.16);
        sl_mode="extreme" -> sweep extreme +/- $0.40 (scalp-style).
    TP1/TP2/TP3: nearest three opposing levels from pools + PDL/PDH
        (his TP1 was the previous-day low).
    RR gate on TP1 >= min_rr. Killzones, 4/day cap, one signal per pool/day.
    Returns (signals, stats). Signal dicts match the v1 shape so the same
    track_swing_outcome scorer applies.
    """
    now = now or datetime.now(UTC)
    if date_filter is not None:
        scan = m1  # caller passes exactly one day of M1
    else:
        scan = m1[m1.index.date == now.date()]
    if len(scan) < 10:
        return [], {}
    stats = {}
    used = set()  # one signal per pool id per day
    signals = []
    n = len(scan)
    # NOTE (7 Oct 2026): n-1, not n-2. The old n-2 was a leftover from v1's
    # confirmation candles and delayed every sniper signal ~2-3 minutes past
    # its entry. Sweep candle is closed, entry bar open is fixed: no repaint.
    for i in range(n - 1):
        sweep = scan.iloc[i]
        ts = scan.index[i]
        for pool in pools:
            try:
                formed = pd.Timestamp(pool["formed_at"])
            except Exception:
                formed = ts
            if formed > ts:
                continue  # pool didn't exist yet (no lookahead)
            if pool["id"] in used and cfg.get("swing_v2_pool_once", True):
                continue
            direction = check_sweep(sweep, pool, cfg)
            if not direction:
                continue
            red = direction == "SHORT"

            entry_bar = scan.iloc[i + 1]          # the reclaim: next M1 open
            entry = float(entry_bar["open"])
            entry_ts = scan.index[i + 1]
            sess = session_of(entry_ts, cfg)
            if not sess:
                stats["off_session"] = stats.get("off_session", 0) + 1
                continue

            pool_px = float(pool["price"])
            if sl_mode == "extreme":
                buf = 0.40
                if red:
                    sl = max(pool_px, float(sweep["high"])) + buf
                else:
                    sl = min(pool_px, float(sweep["low"])) - buf
            else:  # fixed micro-stop, his $2.16
                sl = entry + cfg["swing_v2_sl"] if red else entry - cfg["swing_v2_sl"]

            # TP1/TP2/TP3: nearest three opposing levels (pools + PDL/PDH)
            cands = []
            for p in pools:
                pp = float(p["price"])
                if red and p["side"] == "low" and pp < entry:
                    cands.append(pp)
                elif not red and p["side"] == "high" and pp > entry:
                    cands.append(pp)
            if red and pdl is not None and pdl < entry:
                cands.append(float(pdl))
            if not red and pdh is not None and pdh > entry:
                cands.append(float(pdh))
            cands = sorted(set(round(c, 2) for c in cands), reverse=red)[:3]
            if not cands:
                stats["no_tp"] = stats.get("no_tp", 0) + 1
                continue
            tp1 = cands[0]
            tp2 = cands[1] if len(cands) > 1 else None
            tp3 = cands[2] if len(cands) > 2 else None

            risk = abs(entry - sl)
            if risk <= 0:
                continue
            if risk < cfg.get("swing_v2_min_risk", 0.0):
                stats["tiny_risk"] = stats.get("tiny_risk", 0) + 1
                continue
            rr1 = abs(tp1 - entry) / risk
            if rr1 < cfg["min_rr"]:
                stats["low_rr"] = stats.get("low_rr", 0) + 1
                continue
            # sanity: entry must sit strictly between SL and TP1
            sides_ok = (entry < sl and entry > tp1) if red else (entry > sl and entry < tp1)
            if not sides_ok:
                stats["invalid"] = stats.get("invalid", 0) + 1
                continue

            # premium/discount filter (StockLearners 6 Oct 2026: "50% of the zone"):
            # only SHORT from premium (entry above the day-range midpoint),
            # only LONG from discount (entry below it). Day range = M1 so far.
            if cfg.get("swing_v2_pd_filter", False):
                day_hi = float(scan.iloc[: i + 1]["high"].max())
                day_lo = float(scan.iloc[: i + 1]["low"].min())
                mid = (day_hi + day_lo) / 2.0
                if (red and entry <= mid) or (not red and entry >= mid):
                    stats["pd_filtered"] = stats.get("pd_filtered", 0) + 1
                    continue

            def rr_of(v):
                return None if v is None else round(abs(v - entry) / risk, 2)

            signals.append(
                {
                    "kind": "swing",
                    "direction": direction,
                    "entry": round(entry, 2),
                    "sl": round(sl, 2),
                    "tp": tp1,
                    "tp2": tp2,
                    "tp3": tp3,
                    "rr": round(rr1, 2),
                    "rr2": rr_of(tp2),
                    "rr3": rr_of(tp3),
                    "swing_id": pool["id"],
                    "swing_tf": pool.get("tf", "HTF"),
                    "swing_price": pool_px,
                    "swept_at": ts.isoformat(),
                    "confirm_at": ts.isoformat(),
                    "signal_at": entry_ts.isoformat(),
                    "session": sess,
                    "reason": (
                        f"Swept {'buy' if pool['side'] == 'high' else 'sell'}-side "
                        f"{pool.get('tf', 'HTF')} pool @ {pool_px:,.2f}"
                        + (" ★" if pool.get("premium") else "")
                        + " · sniper reclaim entry"
                    ),
                }
            )
            used.add(pool["id"])
            stats["passed"] = stats.get("passed", 0) + 1

    # one trade per sweep: the same M1 candle can sweep an H1 and an H4 pool
    # at once — keep only the highest-RR signal per sweep minute
    best = {}
    for s in signals:
        k = s["swept_at"]
        if k not in best or s["rr"] > best[k]["rr"]:
            best[k] = s
    if cfg.get("swing_v2_rank", "rr") == "time":
        signals = sorted(best.values(), key=lambda s: s["signal_at"])
    else:
        signals = sorted(best.values(), key=lambda s: s["rr"], reverse=True)
    return signals[: cfg["max_swing_signals_per_day"]], stats


def track_swing_outcome(signal, m1_after, max_hold_hours=48):
    """
    Banked partials at TP1/TP2/TP3. Highest TP reached before the stop counts;
    a stop with no TP banked is -1R. Same-candle: SL first (conservative).
    Exact port of docs/engine.js track_swing_outcome.
    Returns dict with outcome in {'TP1','TP2','TP3','SL','EXPIRED'} (or None
    outcome / None r when there are no bars at all), r, closed_at (isoformat).
    """
    deadline = pd.Timestamp(signal["signal_at"]) + timedelta(hours=max_hold_hours)
    tps = [v for v in (signal["tp"], signal["tp2"], signal["tp3"]) if v is not None]
    rrs = [v for v in (signal["rr"], signal["rr2"], signal["rr3"]) if v is not None]
    entry, sl = signal["entry"], signal["sl"]
    direction = signal["direction"]
    best, closed_at, stopped = 0, None, False
    for ts, c in m1_after.iterrows():
        if ts > deadline:
            break
        hi, lo = float(c["high"]), float(c["low"])
        if direction == "SHORT":
            if hi >= sl:
                stopped = True
                closed_at = closed_at or ts
                break
            for k in range(len(tps), 0, -1):
                if lo <= tps[k - 1] and k > best:
                    best = k
                    closed_at = ts
        else:
            if lo <= sl:
                stopped = True
                closed_at = closed_at or ts
                break
            for k in range(len(tps), 0, -1):
                if hi >= tps[k - 1] and k > best:
                    best = k
                    closed_at = ts
    if best > 0:
        return {"outcome": f"TP{best}", "r": rrs[best - 1],
                "closed_at": closed_at.isoformat()}
    if stopped:
        return {"outcome": "SL", "r": -1.0, "closed_at": closed_at.isoformat()}
    if len(m1_after) == 0:
        return {"outcome": None, "r": None}
    # Expired only if the deadline actually passed inside the data.
    # A trade that hasn't hit TP/SL with time left is OPEN (None), not expired.
    if m1_after.index[-1] <= deadline:
        return {"outcome": None, "r": None}
    window = m1_after[m1_after.index <= deadline]
    if len(window):
        exit_ts, exit_px = window.index[-1], float(window.iloc[-1]["close"])
    else:
        exit_ts, exit_px = m1_after.index[0], float(m1_after.iloc[0]["close"])
    r = (exit_px - entry) / abs(entry - sl) if direction == "LONG" else (entry - exit_px) / abs(entry - sl)
    return {"outcome": "EXPIRED", "r": round(r, 2), "closed_at": exit_ts.isoformat()}


# ----------------------------------------------------------------------------
# LIVE RUN — fetch, compute, write signals.json
# ----------------------------------------------------------------------------
def liquidity_map(price, pools, n=5):
    # Pool grading (mirrors docs/engine.js): merge cross-TF confluence into
    # single zones, grade MAJOR/MINOR/TINY, hide TINY. Display-only.
    equal_tol = 0.60
    zones, used = [], set()
    for p in sorted(pools, key=lambda q: q["price"]):
        if p["id"] in used:
            continue
        group = [p]
        for q in sorted(pools, key=lambda q: q["price"]):
            if (q["id"] != p["id"] and q["id"] not in used and q["side"] == p["side"]
                    and abs(q["price"] - p["price"]) <= equal_tol):
                group.append(q)
                used.add(q["id"])
        used.add(p["id"])
        tfs = "+".join(sorted({g["tf"] for g in group}))
        zp = round(sum(g["price"] for g in group) / len(group), 2)
        touches = max(g["touches"] for g in group)
        cross = len({g["tf"] for g in group}) > 1
        grade = "major" if (cross or touches >= 3) else \
                "minor" if (touches >= 2 or tfs == "H4") else "tiny"
        zones.append({"id": "+".join(g["id"] for g in group), "tf": tfs,
                      "side": p["side"], "price": zp, "touches": touches,
                      "grade": grade, "premium": touches >= 2})
    drawn = [z for z in zones if z["grade"] != "tiny"]
    above = sorted([z for z in drawn if z["price"] >= price], key=lambda z: z["price"])[:n]
    below = sorted([z for z in drawn if z["price"] < price], key=lambda z: z["price"], reverse=True)[:n]
    def row(z):
        return {
            "id": z["id"], "tf": z["tf"], "side": z["side"],
            "price": z["price"], "touches": z["touches"], "grade": z["grade"],
            "premium": z["premium"], "distance": round(abs(z["price"] - price), 2),
        }
    return {"above": [row(z) for z in above], "below": [row(z) for z in below]}


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
