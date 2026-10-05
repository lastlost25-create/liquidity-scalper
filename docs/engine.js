/* ============================================================================
 * Liquidity Scalper — pure price-action liquidity-sweep signal engine.
 * Faithful JavaScript port of engine/engine.py (XAUUSD -> PAXGUSDT feed).
 *
 * NO indicators. Fractal swing highs/lows on H4+H1 (resting stop liquidity),
 * M1 wick sweeps through those pools. Closed candles only — no repaint.
 *
 * Bars: {t, o, h, l, c} with t = UTC timestamp in milliseconds.
 * No DOM, no network here — runs in Node (tests) and in the browser page.
 * ========================================================================== */
'use strict';

const CONFIG = {
  symbol: 'PAXGUSDT',

  // Pool detection (fractal swings on closed candles)
  h1_left: 5, h1_right: 5,          // H1 fractal: 5 bars each side
  h4_left: 3, h4_right: 3,          // H4 fractal: 3 bars each side
  equal_tol: 0.60,                  // equal highs/lows merge within $0.60
  max_pools_per_tf: 30,             // rolling window of pools per timeframe
  pool_max_age_days: 20,            // pools expire after 20 days

  // Sweep detection (on closed M1 candles)
  sweep_pierce: 0.50,               // wick must pierce pool by >= $0.50
  sl_buffer: 0.40,                  // SL sits $0.40 beyond the sweep extreme
  min_rr: 1.5,                      // discard anything under 1.5R
  max_signals_per_day: 4,           // best 4 by R:R only

  // Session filter — killzones in UTC hours
  sessions: [
    ['London', 7, 10],
    ['NewYork', 12, 15],
  ],

  use_trend_filter: false,          // DEFAULT OFF (backtest: destroys the edge)
};

const DAY_MS = 86400000;
const round2 = v => Math.round(v * 100) / 100;
const iso = ms => new Date(ms).toISOString();
const utcDay = ms => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };

/* ----------------------------------------------------------------------------
 * POOL DETECTION — fractal swing highs/lows on closed candles
 * -------------------------------------------------------------------------- */
function fractals(bars, left, right) {
  // Mirrors engine.py: strictly highest/lowest of the window, ties -> earliest wins.
  const highs = [], lows = [];
  for (let i = left; i < bars.length - right; i++) {
    let maxH = -Infinity, maxI = -1, minL = Infinity, minI = -1;
    for (let j = i - left; j <= i + right; j++) {
      if (bars[j].h > maxH) { maxH = bars[j].h; maxI = j; }
      if (bars[j].l < minL) { minL = bars[j].l; minI = j; }
    }
    if (maxI === i) highs.push([bars[i].t, bars[i].h]);
    if (minI === i) lows.push([bars[i].t, bars[i].l]);
  }
  return [highs, lows];
}

function detect_pools(h1bars, h4bars, nowMs) {
  const maxAge = nowMs - CONFIG.pool_max_age_days * DAY_MS;
  const pools = [];
  let pid = 0;
  const tfs = [
    ['H1', h1bars, CONFIG.h1_left, CONFIG.h1_right],
    ['H4', h4bars, CONFIG.h4_left, CONFIG.h4_right],
  ];
  for (const [tf, bars, left, right] of tfs) {
    const [highs, lows] = fractals(bars, left, right);
    const sides = [['high', highs], ['low', lows]];
    for (const [side, swings] of sides) {
      for (const [ts, price] of swings) {
        if (ts < maxAge) continue;
        let merged = null;
        for (const p of pools) {
          if (p.tf === tf && p.side === side && Math.abs(p.price - price) <= CONFIG.equal_tol) {
            merged = p; break;
          }
        }
        if (merged) {
          merged.touches += 1;
          merged.price = (merged.price * (merged.touches - 1) + price) / merged.touches;
          merged.formed_at = Math.max(merged.formed_at, ts);
        } else {
          pid += 1;
          pools.push({
            id: `${tf}-${side}-${pid}`,
            tf, side,
            price: round2(price),
            touches: 1,
            premium: false,
            formed_at: ts,   // ms internally
          });
        }
      }
    }
  }
  for (const p of pools) p.premium = p.touches >= 2;
  // Rolling window: 30 most recently formed pools per timeframe
  pools.sort((a, b) => a.formed_at - b.formed_at);
  const kept = [];
  for (const tf of ['H1', 'H4']) {
    kept.push(...pools.filter(p => p.tf === tf).slice(-CONFIG.max_pools_per_tf));
  }
  kept.sort((a, b) => a.formed_at - b.formed_at);
  return kept.map(p => ({ ...p, price: round2(p.price) }));
}

/* ----------------------------------------------------------------------------
 * STRUCTURE TREND — pure price action: HH+HL / LH+LL / RANGE (context only)
 * -------------------------------------------------------------------------- */
function structure_trend(bars, left, right) {
  const [highs, lows] = fractals(bars, left, right);
  if (highs.length < 2 || lows.length < 2) return 'RANGE';
  const hp = highs[highs.length - 2][1], hc = highs[highs.length - 1][1];
  const lp = lows[lows.length - 2][1], lc = lows[lows.length - 1][1];
  if (hc > hp && lc > lp) return 'UPTREND';
  if (hc < hp && lc < lp) return 'DOWNTREND';
  return 'RANGE';
}

/* ----------------------------------------------------------------------------
 * SWEEP DETECTION + TRADE PLANS — on closed M1 candles
 * -------------------------------------------------------------------------- */
function session_of(tsMs) {
  const d = new Date(tsMs);
  const hour = d.getUTCHours() + d.getUTCMinutes() / 60;
  for (const [name, start, end] of CONFIG.sessions) {
    if (hour >= start && hour < end) return name;
  }
  return null;
}

function check_sweep(candle, pool) {
  const pierce = CONFIG.sweep_pierce;
  if (pool.side === 'high') {
    if (candle.h >= pool.price + pierce && candle.c < pool.price) return 'SHORT';
  } else {
    if (candle.l <= pool.price - pierce && candle.c > pool.price) return 'LONG';
  }
  return null;
}

function nearest_opposing_pool(price, pools, direction) {
  const cands = direction === 'SHORT'
    ? pools.filter(p => p.side === 'low' && p.price < price)
    : pools.filter(p => p.side === 'high' && p.price > price);
  if (!cands.length) return null;
  return cands.reduce((a, b) => direction === 'SHORT'
    ? (b.price > a.price ? b : a)
    : (b.price < a.price ? b : a));
}

function median_spacing(bars) {
  if (bars.length < 3) return 60000;
  const diffs = [];
  for (let i = 1; i < bars.length; i++) diffs.push(bars[i].t - bars[i - 1].t);
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)];
}

function closed_only(bars, nowMs) {
  if (bars.length < 3) return bars;
  const cutoff = nowMs - median_spacing(bars);
  return bars.filter(b => b.t <= cutoff);
}

/**
 * Scan one UTC day of closed M1 bars for sweeps. Mirrors engine.py build_signals.
 * m1bars: closed M1 bars (any span); pools: from detect_pools; h1bars: closed H1.
 * dayMs: any timestamp within the day to scan (defaults to nowMs's day).
 * usedPoolIds: Set of pool ids already used this day (one signal per pool/day).
 * Returns {signals, stats}.
 */
function build_signals(m1bars, pools, h1bars, nowMs, dayMs = null, usedPoolIds = null) {
  const stats = {};
  const day = utcDay(dayMs === null ? nowMs : dayMs);
  const scan = m1bars.filter(b => utcDay(b.t) === day);
  if (scan.length < 2) return { signals: [], stats };
  const used = usedPoolIds || new Set();
  const signals = [];

  for (let i = 0; i < scan.length - 1; i++) {
    const sweep = scan[i];
    const ts = sweep.t;
    const sess = session_of(ts);
    if (!sess) continue;                              // outside killzones
    for (const pool of pools) {
      if (pool.formed_at > ts) continue;              // no lookahead
      if (used.has(pool.id)) continue;                // one signal per pool/day
      const direction = check_sweep(sweep, pool);
      if (!direction) continue;

      let trend = null;
      if (h1bars && h1bars.length) {
        const gh = h1bars.filter(b => b.t < ts);      // H1 closed before sweep
        trend = structure_trend(gh, CONFIG.h1_left, CONFIG.h1_right);
        if (CONFIG.use_trend_filter) {
          const ok = (direction === 'LONG' && trend === 'UPTREND') ||
                     (direction === 'SHORT' && trend === 'DOWNTREND');
          if (!ok) { stats.blocked_trend = (stats.blocked_trend || 0) + 1; continue; }
        }
      }
      stats.passed = (stats.passed || 0) + 1;

      const entry = scan[i + 1].o;                    // next M1 open
      const extreme = direction === 'SHORT' ? sweep.h : sweep.l;
      const sl = direction === 'SHORT' ? extreme + CONFIG.sl_buffer : extreme - CONFIG.sl_buffer;
      const tpPool = nearest_opposing_pool(entry, pools, direction);
      if (!tpPool) continue;
      const tp = tpPool.price;
      const risk = Math.abs(entry - sl), reward = Math.abs(tp - entry);
      if (risk <= 0) continue;
      const rr = reward / risk;
      if (rr < CONFIG.min_rr) continue;

      const bits = [`Swept ${pool.tf} ${pool.side === 'high' ? 'buy' : 'sell'}-side pool @ ${pool.price.toLocaleString('en-US', { minimumFractionDigits: 2 })}` +
        (pool.premium ? ' (equal highs/lows)' : '')];
      if (trend) bits.push(`H1 ${trend.toLowerCase()}`);
      signals.push({
        direction,
        entry: round2(entry), sl: round2(sl), tp: round2(tp), rr: round2(rr),
        pool_id: pool.id, pool_tf: pool.tf, pool_side: pool.side, pool_price: pool.price,
        trend_h1: trend,
        swept_at: iso(ts),
        signal_at: iso(scan[i + 1].t),
        session: sess,
        reason: bits.join(' · '),
      });
      used.add(pool.id);
    }
  }
  signals.sort((a, b) => b.rr - a.rr);
  return { signals: signals.slice(0, CONFIG.max_signals_per_day), stats };
}

/* ----------------------------------------------------------------------------
 * OUTCOME TRACKING — forward-walk closed M1 after entry: TP or SL first?
 * Both print in one candle -> SL first (conservative, like engine.py).
 * -------------------------------------------------------------------------- */
function track_outcome(signal, barsAfter, maxHoldHours = 24) {
  const deadline = new Date(signal.signal_at).getTime() + maxHoldHours * 3600000;
  for (const c of barsAfter) {
    if (c.t > deadline) break;
    let slHit, tpHit;
    if (signal.direction === 'LONG') { slHit = c.l <= signal.sl; tpHit = c.h >= signal.tp; }
    else { slHit = c.h >= signal.sl; tpHit = c.l <= signal.tp; }
    if (slHit || tpHit) {
      const won = tpHit && !slHit;
      return { outcome: won ? 'TP' : 'SL', r: won ? signal.rr : -1.0, closed_at: iso(c.t) };
    }
  }
  const last = barsAfter[barsAfter.length - 1];
  const r = signal.direction === 'LONG'
    ? (last.c - signal.entry) / Math.abs(signal.entry - signal.sl)
    : (signal.entry - last.c) / Math.abs(signal.entry - signal.sl);
  return { outcome: 'EXPIRED', r: round2(r), closed_at: iso(last.t) };
}

function liquidity_map(price, pools, n = 5) {
  const above = pools.filter(p => p.price >= price).sort((a, b) => a.price - b.price).slice(0, n);
  const below = pools.filter(p => p.price < price).sort((a, b) => b.price - a.price).slice(0, n);
  const row = p => ({
    id: p.id, tf: p.tf, side: p.side, price: p.price,
    touches: p.touches, premium: p.premium,
    distance: round2(Math.abs(p.price - price)),
  });
  return { above: above.map(row), below: below.map(row) };
}

// Node + browser export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CONFIG, fractals, detect_pools, structure_trend, session_of,
    check_sweep, nearest_opposing_pool, closed_only, build_signals,
    track_outcome, liquidity_map, iso, utcDay, DAY_MS,
  };
} else if (typeof window !== 'undefined') {
  window.LS = {
    CONFIG, fractals, detect_pools, structure_trend, session_of,
    check_sweep, nearest_opposing_pool, closed_only, build_signals,
    track_outcome, liquidity_map, iso, utcDay, DAY_MS,
  };
}
