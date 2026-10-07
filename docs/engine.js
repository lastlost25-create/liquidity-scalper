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
  min_rr: 2.5,                      // discard anything under 2.5R (raised 5 Oct 2026: backtest +0.664R -> +0.812R/trade)
  max_signals_per_day: 4,           // best 4 by R:R only

  // Session filter — killzones in UTC hours
  sessions: [
    ['London', 6, 10],
    ['NewYork', 12, 15],
  ],

  // Swing setup ("liq bias"): 15m major swings + M1 sweep + confirmation
  m15_left: 5, m15_right: 5,          // 15m fractal for major swings
  confirm_body_ratio: 0.6,            // "good body": body >= 60% of candle range
  max_swing_signals_per_day: 4,       // separate daily cap for swing setups
  swing_sl_buffer: 1.00,             // v1 swing stops (superseded by v2)
  swing_v2_sl: 2.50,                 // v2 sniper SL: fixed $2.50 from entry (his real $2.16, 6 Oct 2026)
  swing_v2_pool_once: false,         // v2: re-sweeps of the same pool may fire (backtest 6 Oct: +3.94R vs +3.16R)
  swing_v2_rank: 'rr',               // v2 final daily pick: 'rr' (top-RR) or 'time' (chronological; backtest: 'rr' wins)
  htf_match_tol: 1.00,               // 15m swing must sit within $1 of an H1/H4 fractal level (HTF confluence)
  disp_min: 0,                       // displacement-origin filter OFF by default; set to $ to require
  disp_bars: 8,                      // forward 15m bars over which displacement is measured

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

// Countdown for the header session clock: { label, ms, live }.
// In a killzone -> time left in it; else time until the next one
// (weekend / Friday-after-close -> Monday 00:00 UTC).
function session_countdown(tsMs) {
  const short = n => n === 'London' ? 'LDN' : n === 'NewYork' ? 'NY' : n;
  const d = new Date(tsMs);
  const day = d.getUTCDay();
  const dayMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (day === 0 || day === 6 || (day === 5 && (d.getUTCHours() + d.getUTCMinutes() / 60) >= 15)) {
    const addDays = day === 6 ? 2 : day === 0 ? 1 : 3;
    return { sess: 'MON', verb: 'OPENS IN', ms: dayMs + addDays * 86400e3 - tsMs, live: false };
  }
  const hour = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
  for (const [name, start, end] of CONFIG.sessions) {
    if (hour >= start && hour < end)
      return { sess: short(name), verb: 'ENDS IN', ms: dayMs + end * 3600e3 - tsMs, live: true };
  }
  const nx = next_session(tsMs);
  return { sess: short(nx.name), verb: 'OPENS IN', ms: nx.atMs - tsMs, live: false };
}

// Next killzone after tsMs: { name, atMs }. Used for the WAIT panel detail.
function next_session(tsMs) {
  const d = new Date(tsMs);
  const dayMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const hour = d.getUTCHours() + d.getUTCMinutes() / 60;
  for (const [name, start] of CONFIG.sessions) {
    if (hour < start) return { name, atMs: dayMs + start * 3600e3 };
  }
  const [name0, start0] = CONFIG.sessions[0];
  return { name: name0, atMs: dayMs + 86400e3 + start0 * 3600e3 };
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
      // one signal per LEVEL per day: an H1 pool and an H4 pool sitting at
      // the same price are one level — a sweep that fires one must not
      // print the other as a second signal (Oct 6 duplicate-level fix).
      for (const p2 of pools) {
        if (p2.side === pool.side && Math.abs(p2.price - pool.price) <= CONFIG.equal_tol) used.add(p2.id);
      }
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
  // Expired only if the deadline actually passed inside the data.
  // A trade that hasn't hit TP/SL with time still left is OPEN (null),
  // not expired — the old code mislabeled every open trade as EXPIRED.
  let pastDeadline = false, exitBar = null;
  for (const c of barsAfter) { if (c.t > deadline) { pastDeadline = true; break; } exitBar = c; }
  if (!pastDeadline) return { outcome: null, r: null };
  const last = exitBar || barsAfter[0];
  if (!last) return { outcome: null, r: null };
  const r = signal.direction === 'LONG'
    ? (last.c - signal.entry) / Math.abs(signal.entry - signal.sl)
    : (signal.entry - last.c) / Math.abs(signal.entry - signal.sl);
  return { outcome: 'EXPIRED', r: round2(r), closed_at: iso(last.t) };
}

/* ----------------------------------------------------------------------------
 * POOL GRADING — which levels deserve ink on the chart.
 * MAJOR: H1+H4 confluence at one price, or 3+ equal touches. The zones the
 *        market remembers — sweeps here get the real reaction.
 * MINOR: double top/bottom (2 touches) or a lone H4 level. Worth watching,
 *        reaction possible but thinner.
 * TINY:  single-touch H1 wick with no confirmation — noise and trap bait.
 *        Fully hidden from chart and panels. Display-only: the signal engine
 *        still scans every pool, so the backtest stays valid.
 * -------------------------------------------------------------------------- */
function liquidity_map(price, pools, n = 5) {
  // merge cross-TF confluence into single zones (one level = one zone)
  const zones = [];
  const used = new Set();
  const sorted = [...pools].sort((a, b) => a.price - b.price);
  for (const p of sorted) {
    if (used.has(p.id)) continue;
    const group = [p];
    for (const q of sorted) {
      if (q.id !== p.id && !used.has(q.id) && q.side === p.side &&
          Math.abs(q.price - p.price) <= CONFIG.equal_tol) {
        group.push(q); used.add(q.id);
      }
    }
    used.add(p.id);
    const tfs = [...new Set(group.map(g => g.tf))].sort().join('+');
    const zp = round2(group.reduce((s, g) => s + g.price, 0) / group.length);
    const touches = Math.max(...group.map(g => g.touches));
    const crossTF = new Set(group.map(g => g.tf)).size > 1;
    const grade = (crossTF || touches >= 3) ? 'major'
                : (touches >= 2 || tfs === 'H4') ? 'minor' : 'tiny';
    zones.push({ id: group.map(g => g.id).join('+'), tf: tfs, side: p.side,
                 price: zp, touches, grade, premium: touches >= 2 });
  }
  const drawn = zones.filter(z => z.grade !== 'tiny');
  const above = drawn.filter(z => z.price >= price).sort((a, b) => a.price - b.price).slice(0, n);
  const below = drawn.filter(z => z.price < price).sort((a, b) => b.price - a.price).slice(0, n);
  const row = z => ({
    id: z.id, tf: z.tf, side: z.side, price: z.price,
    touches: z.touches, grade: z.grade, premium: z.premium,
    distance: round2(Math.abs(z.price - price)),
  });
  return { above: above.map(row), below: below.map(row) };
}

/* ----------------------------------------------------------------------------
 * SWING SETUP ("liq bias") — 15m major swings, M1 sweep, confirmation candles
 *
 * SHORT: price stretches into a 15m swing high and sweeps it on M1
 *        -> 2 red M1 candles -> 1 red candle closing below the low of a
 *        strong-bodied red candle ("good body" >= 60% of range)
 *        -> short at next M1 open, SL above swing extreme + buffer,
 *           TP1/TP2/TP3 = last three 15m swing lows.
 * LONG: mirrored at 15m swing lows. Closed candles only — no repaint.
 * -------------------------------------------------------------------------- */
/* ----------------------------------------------------------------------------
 * V2 SNIPER SWING — screenshot-faithful setup (calibrated 6 Oct 2026 from
 * Mickey's real OANDA trade: LONG 4114.911, SL 4112.755, TP1 4123.335=PDL).
 * Level: the H1/H4 pool itself (his "4h + 1h swing low") — no 15m middleman.
 * Trigger: M1 sweep (wick >= pool +/- sweep_pierce, close back inside).
 * Entry: next M1 open (the reclaim). No confirmation / break candles.
 * SL: slMode 'fixed' -> entry -/+ CONFIG.swing_v2_sl ($2.50 ~ his $2.16);
 *     slMode 'extreme' (default) -> sweep extreme +/- $0.40 (backtest +2.79R).
 * TP1/TP2/TP3: nearest three opposing levels from pools + PDL/PDH.
 * RR gate on TP1 >= min_rr. Killzones, 4/day cap, one trade per sweep.
 * -------------------------------------------------------------------------- */
function build_swing_signals_v2(m1bars, pools, nowMs, dayMs = null, pdl = null, pdh = null, slMode = 'extreme') {
  const day = utcDay(dayMs === null ? nowMs : dayMs);
  const scan = m1bars.filter(b => utcDay(b.t) === day);
  if (scan.length < 10) return { signals: [], stats: {} };
  const used = new Set();
  const signals = [];
  const stats = {};
  const px = v => v.toLocaleString('en-US', { minimumFractionDigits: 2 });

  // NOTE (7 Oct 2026): bound is length-1, not length-2. The old -2 was a
  // leftover from v1's confirmation candles and delayed every sniper signal
  // ~2-3 minutes past its entry — the "very late" blue outline. The sweep
  // candle is closed and the entry bar's open is fixed, so printing as soon
  // as the entry bar exists cannot repaint.
  for (let i = 0; i < scan.length - 1; i++) {
    const sweep = scan[i];
    for (const pool of pools) {
      const formed = (typeof pool.formed_at === 'string') ? new Date(pool.formed_at).getTime() : pool.formed_at;
      if (formed > sweep.t) continue;               // no lookahead
      if (CONFIG.swing_v2_pool_once !== false && used.has(pool.id)) continue;  // one signal per pool/day
      const direction = check_sweep(sweep, pool);
      if (!direction) continue;
      const red = direction === 'SHORT';

      const entryBar = scan[i + 1];                 // the reclaim: next M1 open
      const entry = entryBar.o, signal_at = entryBar.t;
      const sess = session_of(signal_at);
      if (!sess) { stats.off_session = (stats.off_session || 0) + 1; continue; }

      let sl;
      if (slMode === 'extreme') {
        const buf = 0.40;
        sl = red ? Math.max(pool.price, sweep.h) + buf : Math.min(pool.price, sweep.l) - buf;
      } else {
        sl = red ? entry + CONFIG.swing_v2_sl : entry - CONFIG.swing_v2_sl;
      }

      // TP1/TP2/TP3: nearest three opposing levels (pools + PDL/PDH)
      const cands = [];
      for (const p of pools) {
        if (red && p.side === 'low' && p.price < entry) cands.push(p.price);
        else if (!red && p.side === 'high' && p.price > entry) cands.push(p.price);
      }
      if (red && pdl != null && pdl < entry) cands.push(pdl);
      if (!red && pdh != null && pdh > entry) cands.push(pdh);
      const uniq = [...new Set(cands.map(c => round2(c)))].sort((a, b) => red ? b - a : a - b).slice(0, 3);
      if (!uniq.length) { stats.no_tp = (stats.no_tp || 0) + 1; continue; }
      const tp1 = uniq[0], tp2 = uniq.length > 1 ? uniq[1] : null, tp3 = uniq.length > 2 ? uniq[2] : null;
      const risk = Math.abs(entry - sl);
      if (risk <= 0) continue;
      const rr1 = Math.abs(tp1 - entry) / risk;
      if (rr1 < CONFIG.min_rr) { stats.low_rr = (stats.low_rr || 0) + 1; continue; }
      // sanity: entry must sit strictly between SL and TP1 (never already through the stop)
      const sidesOk = red ? (entry < sl && entry > tp1) : (entry > sl && entry < tp1);
      if (!sidesOk) { stats.invalid = (stats.invalid || 0) + 1; continue; }
      const rrOf = v => v == null ? null : round2(Math.abs(v - entry) / risk);

      signals.push({
        kind: 'swing',
        direction,
        entry: round2(entry), sl: round2(sl),
        tp: tp1, tp2, tp3,
        rr: round2(rr1), rr2: rrOf(tp2), rr3: rrOf(tp3),
        swing_id: pool.id, swing_tf: pool.tf || 'HTF', swing_price: pool.price,
        swept_at: iso(sweep.t), confirm_at: iso(sweep.t),
        signal_at: iso(signal_at), session: sess,
        reason: `Swept ${pool.side === 'high' ? 'buy' : 'sell'}-side ${pool.tf || 'HTF'} pool @ ${px(pool.price)}` +
          (pool.premium ? ' ★' : '') + ' · sniper reclaim entry',
      });
      used.add(pool.id);
      stats.passed = (stats.passed || 0) + 1;
    }
  }
  // one trade per sweep: the same M1 candle can sweep an H1 and an H4 pool
  // at once — keep only the highest-RR signal per sweep minute
  const best = new Map();
  for (const s of signals) {
    if (!best.has(s.swept_at) || s.rr > best.get(s.swept_at).rr) best.set(s.swept_at, s);
  }
  const out = CONFIG.swing_v2_rank === 'time'
    ? [...best.values()].sort((a, b) => a.signal_at < b.signal_at ? -1 : 1)
    : [...best.values()].sort((a, b) => b.rr - a.rr);
  return { signals: out.slice(0, CONFIG.max_swing_signals_per_day), stats };
}

/* ----------------------------------------------------------------------------
 * SWING OUTCOME — partials banked at TP1/TP2/TP3. Highest TP reached before
 * the stop counts; a stop with no TP banked is -1R. Same-candle: SL first.
 * -------------------------------------------------------------------------- */
function track_swing_outcome(signal, barsAfter, maxHoldHours = 48) {
  const deadline = new Date(signal.signal_at).getTime() + maxHoldHours * 3600000;
  const tps = [signal.tp, signal.tp2, signal.tp3].filter(v => v != null);
  const rrs = [signal.rr, signal.rr2, signal.rr3].filter(v => v != null);
  let best = 0, closedAt = null, stopped = false;
  for (const c of barsAfter) {
    if (c.t > deadline) break;
    if (signal.direction === 'SHORT') {
      if (c.h >= signal.sl) { stopped = true; closedAt = closedAt || c.t; break; }
      for (let k = tps.length; k >= 1; k--) {
        if (c.l <= tps[k - 1] && k > best) { best = k; closedAt = c.t; }
      }
    } else {
      if (c.l <= signal.sl) { stopped = true; closedAt = closedAt || c.t; break; }
      for (let k = tps.length; k >= 1; k--) {
        if (c.h >= tps[k - 1] && k > best) { best = k; closedAt = c.t; }
      }
    }
  }
  if (best > 0) return { outcome: 'TP' + best, r: rrs[best - 1], closed_at: iso(closedAt) };
  if (stopped) return { outcome: 'SL', r: -1.0, closed_at: iso(closedAt) };
  // Expired only if the deadline actually passed inside the data.
  // A trade that hasn't hit TP/SL with time still left is OPEN (null),
  // not expired — the old code mislabeled every open trade as EXPIRED.
  let pastDeadline = false, sexitBar = null;
  for (const c of barsAfter) { if (c.t > deadline) { pastDeadline = true; break; } sexitBar = c; }
  if (!pastDeadline) return { outcome: null, r: null };
  const last = sexitBar || barsAfter[0];
  if (!last) return { outcome: null, r: null };
  const r = signal.direction === 'LONG'
    ? (last.c - signal.entry) / Math.abs(signal.entry - signal.sl)
    : (signal.entry - last.c) / Math.abs(signal.entry - signal.sl);
  return { outcome: 'EXPIRED', r: round2(r), closed_at: iso(last.t) };
}

// Node + browser export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CONFIG, fractals, detect_pools, structure_trend, session_of, next_session, session_countdown,
    check_sweep, nearest_opposing_pool, closed_only, build_signals, build_swing_signals_v2,
    track_outcome, track_swing_outcome, liquidity_map, iso, utcDay, DAY_MS,
  };
} else if (typeof window !== 'undefined') {
  window.LS = {
    CONFIG, fractals, detect_pools, structure_trend, session_of, next_session, session_countdown,
    check_sweep, nearest_opposing_pool, closed_only, build_signals, build_swing_signals_v2,
    track_outcome, track_swing_outcome, liquidity_map, iso, utcDay, DAY_MS,
  };
}
